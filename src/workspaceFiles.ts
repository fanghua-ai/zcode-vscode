import * as fs from "fs";
import * as path from "path";

export type FileTarget = { absolute: string; insideWorkspace: boolean };

const isUncPath = (value: string) => /^[\\/]{2}/.test(value);

/**
 * Plain local paths only: no NUL or URL schemes (drive letters are fine). `//` and `\\` prefixes are UNC
 * paths on Windows and are allowed there, subject to the lexical check in resolveFileTarget; elsewhere they are rejected.
 */
export function isPlainFilePath(filePath: string, platform = process.platform): boolean {
  return !!filePath && !filePath.includes("\0") && (platform === "win32" || !isUncPath(filePath)) &&
    !(/^[a-z][a-z\d+.-]*:/i.test(filePath) && !/^[a-z]:[\\/]/i.test(filePath));
}

/** String-only containment check (win32 semantics, case-insensitive), used before any fs call. */
export function lexicallyInsideRoots(roots: readonly string[], filePath: string, api: path.PlatformPath = path.win32): boolean {
  const usable = roots.filter(root => typeof root === "string" && !!root);
  if (!usable.length) return false;
  const target = api.resolve(usable[0], filePath);
  return usable.some(root => {
    const relative = api.relative(api.resolve(root), target);
    return relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
  });
}

export type LinkFs = {
  /** null when the entry does not exist; throws for other errors. */
  lstat(entry: string): { isSymbolicLink(): boolean } | null;
  readlink(entry: string): string;
};

const nodeLinkFs: LinkFs = {
  lstat(entry) {
    try { return fs.lstatSync(entry); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    }
  },
  readlink: entry => fs.readlinkSync(entry),
};

const MAX_LINK_HOPS = 40;

/** `\\?\UNC\host\share` and `\??\UNC\...` name the same share as `\\host\share`; `\\?\C:\x` is plain `C:\x`. */
function normalizeLinkTarget(target: string): string {
  const unc = /^[\\/]{2}[?.][\\/]UNC[\\/]|^[\\/]\?\?[\\/]UNC[\\/]/i.exec(target);
  if (unc) return `\\\\${target.slice(unc[0].length)}`;
  const drive = /^(?:[\\/]{2}\?|[\\/]\?\?)[\\/](?=[a-z]:)/i.exec(target);
  return drive ? target.slice(drive[0].length) : target;
}

/**
 * Windows only: walk the path one component at a time with lstat/readlink and refuse it if any symlink or
 * junction on the way points at a share outside the workspace. This runs before realpath, which would
 * otherwise follow the link and open the SMB connection. Device paths (\\?\, \\.\) count as shares.
 * Over-long link chains and unreadable components are refused too.
 *
 * Known limits, accepted on purpose:
 * - A link to a mapped network drive (Z:\...) is a plain drive path on strings alone, so it is not refused
 *   here and realpath will reach that share. The mapping was set up and authenticated by the user, unlike an
 *   arbitrary \\host\share named by a link.
 * - The walk and the later realpath are separate calls, so a link replaced in between is followed unchecked.
 *   Exploiting that needs someone who can already write inside the workspace on this machine.
 */
export function linksAvoidForeignShares(roots: readonly string[], target: string, linkFs: LinkFs = nodeLinkFs): boolean {
  const api = path.win32;
  let pending = api.resolve(target);
  let hops = 0;
  try {
    restart: for (;;) {
      const root = api.parse(pending).root;
      const parts = pending.slice(root.length).split(/[\\/]+/).filter(Boolean);
      let current = root;
      for (let i = 0; i < parts.length; i++) {
        const next = api.join(current, parts[i]);
        const stat = linkFs.lstat(next);
        if (!stat) return true;
        if (stat.isSymbolicLink()) {
          if (++hops > MAX_LINK_HOPS) return false;
          const resolved = api.resolve(current, normalizeLinkTarget(linkFs.readlink(next)));
          if (isUncPath(resolved) && !lexicallyInsideRoots(roots, resolved)) return false;
          pending = api.join(resolved, ...parts.slice(i + 1));
          continue restart;
        }
        current = next;
      }
      return true;
    }
  } catch {
    return false;
  }
}

/** realpath that tolerates missing tails (deleted or not yet written files): resolve the nearest existing parent. */
export function realpathAllowMissing(filePath: string): string {
  const missing: string[] = [];
  let current = path.resolve(filePath);
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(filePath);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** path.relative instead of startsWith, so `/w-other` is not inside `/w`; win32 compares case-insensitively. */
export function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * The workspace roots plus their canonical paths, e.g. `C:\\work` and the `\\\\nas\\team\\repo` it links to. Only the
 * roots the user opened are resolved; link targets found while walking a file path never join this set. It is
 * rebuilt on every call, so a changed root or root link takes effect immediately.
 */
export function workspaceRootAliases(roots: readonly string[], realpath: (entry: string) => string = realpathAllowMissing): string[] {
  const aliases = roots.filter(root => typeof root === "string" && !!root);
  for (const root of [...aliases]) {
    let canonical: string;
    try { canonical = realpath(root); } catch { continue; }
    if (!aliases.includes(canonical)) aliases.push(canonical);
  }
  return aliases;
}

/**
 * Resolve a webview-supplied path against the workspace roots after following symlinks.
 * Relative paths resolve against the first root. Returns null for paths that are not plain local paths.
 */
export function resolveFileTarget(roots: readonly string[], filePath: string, platform = process.platform): FileTarget | null {
  if (typeof filePath !== "string" || !isPlainFilePath(filePath, platform)) return null;
  const usableRoots = roots.filter(root => typeof root === "string" && !!root);
  if (!path.isAbsolute(filePath) && !usableRoots.length) return null;
  const win32 = platform === "win32";
  // Touching \\host\share makes Windows open an SMB connection (and may send NTLM credentials), so a UNC
  // target outside the workspace is rejected on strings alone, before realpath or any confirmation prompt.
  // A root that is itself a link to a share (C:\\work -> \\\\nas\\team\\repo) trusts that share path as well.
  let trusted: string[] | undefined;
  const trustedRoots = () => (trusted ??= workspaceRootAliases(usableRoots));
  if (win32 && isUncPath(path.win32.resolve(usableRoots[0] ?? "", filePath)) &&
      !lexicallyInsideRoots(usableRoots, filePath) && !lexicallyInsideRoots(trustedRoots(), filePath)) return null;
  // A symlink or junction inside the workspace may lead to a foreign share: check its target before realpath follows it.
  if (win32 && !linksAvoidForeignShares(trustedRoots(), path.win32.resolve(usableRoots[0] ?? "", filePath))) return null;
  const absolute = realpathAllowMissing(path.resolve(usableRoots[0] ?? "", filePath));
  const insideWorkspace = usableRoots.some(root => isInsideRoot(realpathAllowMissing(root), absolute));
  // Backstop for anything the link walk could not see: never offer to open a foreign share.
  if (win32 && isUncPath(absolute) && !insideWorkspace) return null;
  return { absolute, insideWorkspace };
}
