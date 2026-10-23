import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isInsideRoot, isPlainFilePath, lexicallyInsideRoots, linksAvoidForeignShares, workspaceRootAliases, realpathAllowMissing, resolveFileTarget, type LinkFs } from "./workspaceFiles";

function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zcode-files-")));
  const root = path.join(base, "w");
  const other = path.join(base, "w-other");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(root, "src", "a.ts"), "a");
  fs.writeFileSync(path.join(other, "secret.txt"), "s");
  return { base, root, other, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test("non-plain paths are rejected", () => {
  for (const p of ["", "a\0b", "//server/share/x", "\\\\server\\share\\x", "file:///etc/passwd", "https://x/y", "vscode-remote://h/a", "command:foo"]) {
    assert.equal(isPlainFilePath(p), false, p);
    assert.equal(resolveFileTarget(["/w"], p), null, p);
  }
  assert.equal(isPlainFilePath("C:\\work\\a.ts"), true);
  assert.equal(isPlainFilePath("src/a.ts"), true);
});

test("relative and absolute paths inside the workspace are inside", () => {
  const s = sandbox();
  try {
    assert.deepEqual(resolveFileTarget([s.root], "src/a.ts"), { absolute: path.join(s.root, "src", "a.ts"), insideWorkspace: true });
    assert.equal(resolveFileTarget([s.root], path.join(s.root, "src", "a.ts"))?.insideWorkspace, true);
    assert.equal(resolveFileTarget([s.root], ".zcode/plans/plan-1.md")?.insideWorkspace, true, "missing files resolve via their parent");
  } finally { s.cleanup(); }
});

test("traversal, sibling prefixes and symlinks out of the workspace are outside", () => {
  const s = sandbox();
  try {
    assert.equal(resolveFileTarget([s.root], "../w-other/secret.txt")?.insideWorkspace, false);
    assert.equal(resolveFileTarget([s.root], path.join(s.other, "secret.txt"))?.insideWorkspace, false);
    assert.equal(isInsideRoot(s.root, s.other), false);
    fs.symlinkSync(s.other, path.join(s.root, "link"));
    const viaLink = resolveFileTarget([s.root], "link/secret.txt");
    assert.deepEqual(viaLink, { absolute: path.join(s.other, "secret.txt"), insideWorkspace: false });
    assert.equal(resolveFileTarget([s.root], "link/not-yet.txt")?.insideWorkspace, false);
  } finally { s.cleanup(); }
});

test("any workspace folder counts in a multi-root workspace", () => {
  const s = sandbox();
  try {
    assert.equal(resolveFileTarget([s.root, s.other], path.join(s.other, "secret.txt"))?.insideWorkspace, true);
    assert.equal(resolveFileTarget([s.root, s.other], "src/a.ts")?.absolute, path.join(s.root, "src", "a.ts"));
  } finally { s.cleanup(); }
});

test("relative paths need a root and missing tails keep their names", () => {
  assert.equal(resolveFileTarget([], "src/a.ts"), null);
  assert.equal(resolveFileTarget(["", ""], "src/a.ts"), null);
  assert.equal(resolveFileTarget([], "/definitely/missing/x.ts")?.insideWorkspace, false);
  assert.equal(realpathAllowMissing("/definitely/missing/x.ts"), path.resolve("/definitely/missing/x.ts"));
});

test("UNC paths are decided on strings before touching the file system", () => {
  assert.equal(isPlainFilePath("\\\\server\\share\\a.ts", "win32"), true);
  assert.equal(isPlainFilePath("//server/share/a.ts", "win32"), true);
  assert.equal(isPlainFilePath("\\\\server\\share\\a.ts", "linux"), false);
  const share = "\\\\nas\\team\\repo";
  assert.equal(lexicallyInsideRoots([share], "src\\a.ts"), true);
  assert.equal(lexicallyInsideRoots([share], "\\\\NAS\\Team\\repo\\b.ts"), true, "case-insensitive");
  assert.equal(lexicallyInsideRoots([share], "..\\other\\x"), false);
  assert.equal(lexicallyInsideRoots([share], "\\\\nas\\team\\repo-other\\x"), false);
  assert.equal(lexicallyInsideRoots(["C:\\work"], "\\\\attacker\\share\\x"), false);
  // Outside UNC targets return null without any fs access (these hosts do not exist).
  for (const target of ["\\\\attacker\\share\\x", "//attacker/share/x", "\\\\?\\UNC\\attacker\\share\\x"]) {
    assert.equal(resolveFileTarget(["C:\\work"], target, "win32"), null, target);
    assert.equal(resolveFileTarget([share], target, "win32"), null, target);
  }
  assert.equal(resolveFileTarget([share], "..\\..\\elsewhere\\x", "win32"), null);
});

/** In-memory Windows tree: entries map a lower-cased path to a link target, or to null for a plain entry. Records every touched path. */
function fakeWindowsFs(entries: Record<string, string | null>) {
  const touched: string[] = [];
  const key = (entry: string) => entry.toLowerCase();
  const linkFs: LinkFs = {
    lstat(entry) {
      touched.push(entry);
      if (!(key(entry) in entries)) return null;
      return { isSymbolicLink: () => entries[key(entry)] !== null };
    },
    readlink(entry) {
      const target = entries[key(entry)];
      if (target == null) throw new Error("not a link");
      return target;
    },
  };
  return { linkFs, touched };
}

test("Windows links to foreign shares are refused before anything follows them", () => {
  const work = "C:\\work";
  const base = { "c:\\work": null, "c:\\work\\src": null, "c:\\work\\src\\a.ts": null };
  for (const linkTarget of ["\\\\attacker\\share", "//attacker/share", "\\\\?\\UNC\\attacker\\share", "\\??\\UNC\\attacker\\share", "\\\\.\\pipe\\x"]) {
    const { linkFs, touched } = fakeWindowsFs({ ...base, "c:\\work\\link": linkTarget });
    assert.equal(linksAvoidForeignShares([work], "C:\\work\\link\\secret.txt", linkFs), false, linkTarget);
    assert.ok(touched.every(entry => !/^[\\/]{2}/.test(entry)), `no share path was touched for ${linkTarget}`);
  }
  // A chain through a local link still ends at the share and is refused.
  const chain = fakeWindowsFs({ ...base, "c:\\work\\a": "C:\\work\\b", "c:\\work\\b": "..\\hop", "c:\\hop": "\\\\attacker\\share" });
  assert.equal(linksAvoidForeignShares([work], "C:\\work\\a\\x", chain.linkFs), false);
  assert.ok(chain.touched.every(entry => !/^[\\/]{2}/.test(entry)));
  // Link loops are refused instead of spinning.
  const loop = fakeWindowsFs({ ...base, "c:\\work\\a": "C:\\work\\b", "c:\\work\\b": "C:\\work\\a" });
  assert.equal(linksAvoidForeignShares([work], "C:\\work\\a\\x", loop.linkFs), false);
});

test("Windows links that stay local or inside a workspace share are allowed", () => {
  const plain = fakeWindowsFs({ "c:\\work": null, "c:\\work\\src": null, "c:\\work\\src\\a.ts": null });
  assert.equal(linksAvoidForeignShares(["C:\\work"], "C:\\work\\src\\a.ts", plain.linkFs), true);
  assert.equal(linksAvoidForeignShares(["C:\\work"], "C:\\work\\src\\missing\\x.ts", plain.linkFs), true, "missing tails stop the walk");
  const local = fakeWindowsFs({ "c:\\work": null, "c:\\work\\link": "\\\\?\\D:\\data", "d:\\data": null });
  assert.equal(linksAvoidForeignShares(["C:\\work"], "C:\\work\\link\\x", local.linkFs), true, "\\\\?\\D: is a local drive");
  assert.ok(local.touched.includes("D:\\data\\x"));
  const share = "\\\\nas\\team\\repo";
  const sameShare = fakeWindowsFs({ "\\\\nas\\team\\repo": null, "\\\\nas\\team\\repo\\link": "\\\\nas\\team\\repo\\other" });
  assert.equal(linksAvoidForeignShares([share], "\\\\nas\\team\\repo\\link\\x", sameShare.linkFs), true);
  const otherShare = fakeWindowsFs({ "\\\\nas\\team\\repo": null, "\\\\nas\\team\\repo\\link": "\\\\nas\\team\\private" });
  assert.equal(linksAvoidForeignShares([share], "\\\\nas\\team\\repo\\link\\x", otherShare.linkFs), false);
  const unreadable: LinkFs = { lstat: () => { throw new Error("EACCES"); }, readlink: () => "" };
  assert.equal(linksAvoidForeignShares(["C:\\work"], "C:\\work\\x", unreadable), false, "unreadable components are refused");
});

test("a workspace root that links to a share trusts that share, and only that share", () => {
  const work = "C:\\work";
  const share = "\\\\nas\\team\\repo";
  const realpaths: Record<string, string> = { [work]: share };
  const aliases = workspaceRootAliases([work], entry => realpaths[entry] ?? entry);
  assert.deepEqual(aliases, [work, share]);
  const tree = {
    "c:\\work": share,
    "\\\\nas\\team\\repo": null,
    "\\\\nas\\team\\repo\\src": null,
    "\\\\nas\\team\\repo\\src\\a.ts": null,
    "\\\\nas\\team\\repo\\sub": "\\\\nas\\team\\repo\\src",
    "\\\\nas\\team\\repo\\up": "\\\\nas\\team\\private",
    "\\\\nas\\team\\repo\\away": "\\\\other\\share",
    "\\\\nas\\team\\repo\\dotdot": "..\\private",
  };
  const ok = (target: string) => linksAvoidForeignShares(aliases, target, fakeWindowsFs(tree).linkFs);
  assert.equal(ok("C:\\work\\src\\a.ts"), true, "files under the root alias");
  assert.equal(ok("\\\\nas\\team\\repo\\src\\a.ts"), true, "files under the canonical root");
  assert.equal(ok("C:\\work\\sub\\a.ts"), true, "links that stay inside the canonical root");
  assert.equal(ok("C:\\work\\up\\x"), false, "same share, outside the workspace");
  assert.equal(ok("C:\\work\\away\\x"), false, "a different share");
  assert.equal(ok("C:\\work\\dotdot\\x"), false, "relative escape from the canonical root");
  // Without the alias the root link itself looks like a foreign share.
  assert.equal(linksAvoidForeignShares([work], "C:\\work\\src\\a.ts", fakeWindowsFs(tree).linkFs), false);
  // Link targets met while walking never become trusted: the alias set is built from roots only.
  assert.deepEqual(workspaceRootAliases([work], entry => entry), [work], "a root that is not a link adds nothing");
  // Re-resolved on every call: once the root link is repointed, the old share is no longer trusted.
  realpaths[work] = "\\\\nas\\team\\other";
  assert.deepEqual(workspaceRootAliases([work], entry => realpaths[entry] ?? entry), [work, "\\\\nas\\team\\other"]);
});
