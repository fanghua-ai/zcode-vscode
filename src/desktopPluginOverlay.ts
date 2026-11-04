import { suppressedDesktopPluginIds } from "./desktopPluginChoices";
import { createRequire } from "module";
import type * as fs from "fs";
import * as path from "path";
import { isDeepStrictEqual } from "util";

/**
 * Official plugins whose whole component set starts desktop-only MCP
 * processes. Disabling one also drops its model tools and skills.
 * node_repl is not itself a plugin; it is injected while browser-use or
 * computer-use is enabled. zcode-cua is the legacy id of computer-use.
 * These stay as saved for the desktop app. The VS Code app-server only
 * sees them as disabled, and every write puts the on-disk keys back,
 * even when a migration or rewrite omitted them.
 */
export const DESKTOP_ONLY_PLUGIN_IDS = suppressedDesktopPluginIds([]);
let suppressedPluginIds: readonly string[] = DESKTOP_ONLY_PLUGIN_IDS;

export const DESKTOP_PLUGIN_OVERLAY_ENV = "ZCODE_VSCODE_DESKTOP_PLUGIN_OVERLAY";

type JsonObject = Record<string, unknown>;

export function isRuntimeConfigPath(filePath: unknown): boolean {
  if (typeof filePath !== "string" && !Buffer.isBuffer(filePath) && !(filePath instanceof URL)) {
    return false;
  }
  const text = filePath instanceof URL ? filePath.pathname : filePath.toString();
  const normalized = path.normalize(text);
  const base = path.basename(normalized);
  if (base === "zcode.json") return true;
  if (base !== "config.json") return false;
  const parent = path.basename(path.dirname(normalized));
  if (parent === ".zcode") return true;
  return parent === "cli" && path.basename(path.dirname(path.dirname(normalized))) === ".zcode";
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parsed view of a runtime config with the desktop-only plugins forced off. */
export function overlayConfigText(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!isPlainObject(parsed)) return text;
  const plugins = isPlainObject(parsed.plugins) ? { ...parsed.plugins } : {};
  const enabled = isPlainObject(plugins.enabledPlugins) ? { ...plugins.enabledPlugins } : {};
  for (const id of suppressedPluginIds) enabled[id] = false;
  return JSON.stringify({ ...parsed, plugins: { ...plugins, enabledPlugins: enabled } });
}

function originalEnabledPlugins(original: JsonObject | null): JsonObject | undefined {
  if (!original || !isPlainObject(original.plugins) || !isPlainObject(original.plugins.enabledPlugins)) return undefined;
  return original.plugins.enabledPlugins;
}

/**
 * Put the overlaid plugin ids back to their on-disk values. A missing key
 * is not a deletion: official migration removes the legacy computer-use id
 * after reading the injected canonical id, and that write must not drop
 * either saved value. Other plugin ids follow the incoming document.
 */
function restoreObject(original: JsonObject | null, incoming: JsonObject): JsonObject {
  const copy = structuredClone(incoming);
  const origEnabled = originalEnabledPlugins(original);
  const incomingPlugins = isPlainObject(copy.plugins) ? copy.plugins : undefined;
  const incomingEnabled = incomingPlugins && isPlainObject(incomingPlugins.enabledPlugins)
    ? incomingPlugins.enabledPlugins
    : undefined;
  const enabled: JsonObject = incomingEnabled ?? {};
  let restoreDiskKey = false;
  for (const id of suppressedPluginIds) {
    const onDisk = !!origEnabled && Object.prototype.hasOwnProperty.call(origEnabled, id);
    if (onDisk) {
      restoreDiskKey = true;
      enabled[id] = origEnabled[id];
    } else {
      delete enabled[id];
    }
  }
  if (incomingPlugins && incomingEnabled) {
    const origHadEntries = !!origEnabled && Object.keys(origEnabled).length > 0;
    if (Object.keys(enabled).length === 0 && !origHadEntries) delete incomingPlugins.enabledPlugins;
    if (Object.keys(incomingPlugins).length === 0 && !(original && isPlainObject(original.plugins))) delete copy.plugins;
    return copy;
  }
  if (!restoreDiskKey) return copy;
  const plugins = incomingPlugins ?? {};
  plugins.enabledPlugins = enabled;
  copy.plugins = plugins;
  return copy;
}

/**
 * Drop the process-local disables before bytes are committed to a shared
 * config file. A write that only differs by those disables keeps the
 * original bytes, including formatting.
 */
export function restoreConfigText(originalText: string | null, incomingText: string): string {
  let incoming: unknown;
  try {
    incoming = JSON.parse(incomingText);
  } catch {
    return incomingText;
  }
  if (!isPlainObject(incoming)) return incomingText;
  let original: JsonObject | null = null;
  if (originalText) {
    try {
      const parsed: unknown = JSON.parse(originalText);
      if (isPlainObject(parsed)) original = parsed;
    } catch {
      original = null;
    }
  }
  const restored = restoreObject(original, incoming);
  if (original && originalText && isDeepStrictEqual(restored, original)) return originalText;
  return JSON.stringify(restored, null, 2) + (incomingText.endsWith("\n") ? "\n" : "");
}

function encodingOf(options: unknown): string | null {
  if (typeof options === "string") return options;
  if (isPlainObject(options) && typeof options.encoding === "string") return options.encoding;
  return null;
}

function asBuffer(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === "string") return Buffer.from(data);
  if (data instanceof Uint8Array) return Buffer.from(data);
  return null;
}

function overlayFileData(data: unknown, options: unknown): unknown {
  const buf = asBuffer(data);
  if (!buf) return data;
  const encoding = encodingOf(options);
  const text = buf.toString(!encoding || encoding === "buffer" ? "utf8" : encoding as BufferEncoding);
  const next = overlayConfigText(text);
  if (next === text) return data;
  if (typeof data === "string") return next;
  return Buffer.from(next);
}

let installed = false;

/** Patch this process so shared ZCode config reads hide the desktop-only plugins. */
export function installDesktopPluginOverlay(allowed: readonly string[] = []): void {
  if (installed) return;
  installed = true;
  suppressedPluginIds = suppressedDesktopPluginIds(allowed);
  const nodeRequire = createRequire(__filename);
  const modules = [nodeRequire("fs"), nodeRequire("node:fs")] as Array<typeof fs>;
  const seen = new Set<object>();
  for (const candidate of modules) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    patchFsModule(candidate);
  }
}

/** Patch Node's real fs exports. A bundled import of fs is a different object. */
function patchFsModule(fs: typeof import("fs")): void {
  const mutable = fs as unknown as {
    readFileSync: typeof fs.readFileSync;
    writeFileSync: typeof fs.writeFileSync;
    renameSync: typeof fs.renameSync;
    readFile: typeof fs.readFile;
    writeFile: typeof fs.writeFile;
    rename: typeof fs.rename;
  };
  const readFileSync = fs.readFileSync;
  const writeFileSync = fs.writeFileSync;
  const renameSync = fs.renameSync;
  const readFile = fs.readFile;
  const writeFile = fs.writeFile;
  const rename = fs.rename;
  const promises = fs.promises;
  const mutablePromises = promises as unknown as {
    readFile: typeof promises.readFile;
    writeFile: typeof promises.writeFile;
    rename: typeof promises.rename;
  };
  const promiseReadFile = promises.readFile;
  const promiseWriteFile = promises.writeFile;
  const promiseRename = promises.rename;

  const readOriginal = (dest: fs.PathLike): Buffer | null => {
    try {
      return readFileSync(dest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };

  const restoreAgainst = (dest: fs.PathLike, data: unknown): unknown => {
    const incoming = asBuffer(data);
    if (!incoming) return data;
    const original = readOriginal(dest);
    const restored = restoreConfigText(original ? original.toString("utf8") : null, incoming.toString("utf8"));
    if (typeof data === "string") return restored;
    return Buffer.from(restored);
  };

  const matchesDisk = (dest: fs.PathLike, data: unknown): boolean => {
    const next = asBuffer(data);
    if (!next) return false;
    const original = readOriginal(dest);
    return original !== null && next.equals(original);
  };

  /** Restore a temp config before it replaces the shared file. True means the shared bytes are already correct, so the temp was removed and the rename must not run. */
  const prepareRename = (src: fs.PathLike, dest: fs.PathLike): boolean => {
    if (!isRuntimeConfigPath(dest)) return false;
    const incoming = readFileSync(src);
    const next = restoreAgainst(dest, incoming);
    if (matchesDisk(dest, next)) {
      try {
        fs.unlinkSync(src);
      } catch {
        // A leftover temp is outside the config path. Replacing dest would republish the overlay.
      }
      return true;
    }
    if (Buffer.isBuffer(next) && next.equals(incoming)) return false;
    let mode: number | undefined;
    try {
      mode = fs.statSync(src).mode;
    } catch {
      mode = undefined;
    }
    writeFileSync(src, next as string | Buffer, mode === undefined ? undefined : { mode });
    return false;
  };

  const patchedReadFileSync: typeof fs.readFileSync = ((file, options) => {
    const data = readFileSync(file, options as never);
    if (!isRuntimeConfigPath(file)) return data;
    return overlayFileData(data, options);
  }) as typeof fs.readFileSync;

  const patchedWriteFileSync: typeof fs.writeFileSync = ((file, data, options) => {
    if (!isRuntimeConfigPath(file)) {
      writeFileSync(file, data as string | Buffer, options as never);
      return;
    }
    const next = restoreAgainst(file as fs.PathLike, data);
    if (matchesDisk(file as fs.PathLike, next)) return;
    writeFileSync(file, next as string | Buffer, options as never);
  }) as typeof fs.writeFileSync;

  mutable.readFileSync = patchedReadFileSync;
  mutable.writeFileSync = patchedWriteFileSync;
  mutable.renameSync = ((src, dest) => {
    if (prepareRename(src, dest)) return;
    renameSync(src, dest);
  }) as typeof fs.renameSync;

  mutable.readFile = ((file: fs.PathLike, options?: unknown, callback?: (err: NodeJS.ErrnoException | null, data?: unknown) => void) => {
    if (typeof options === "function") {
      callback = options as (err: NodeJS.ErrnoException | null, data?: unknown) => void;
      options = undefined;
    }
    return readFile(file, options as never, ((err: NodeJS.ErrnoException | null, data?: unknown) => {
      if (err || !callback || !isRuntimeConfigPath(file)) {
        callback?.(err, data);
        return;
      }
      try {
        callback(null, overlayFileData(data, options));
      } catch (error) {
        callback(error as NodeJS.ErrnoException);
      }
    }) as (err: NodeJS.ErrnoException | null, data: string | Buffer) => void);
  }) as typeof fs.readFile;

  mutable.writeFile = ((file: fs.PathLike, data: unknown, options?: unknown, callback?: (err: NodeJS.ErrnoException | null) => void) => {
    if (typeof options === "function") {
      callback = options as (err: NodeJS.ErrnoException | null) => void;
      options = undefined;
    }
    try {
      if (isRuntimeConfigPath(file)) {
        const next = restoreAgainst(file, data);
        if (matchesDisk(file, next)) {
          callback?.(null);
          return;
        }
        data = next;
      }
    } catch (error) {
      callback?.(error as NodeJS.ErrnoException);
      return;
    }
    return writeFile(file, data as string | Buffer, options as never, callback as (err: NodeJS.ErrnoException | null) => void);
  }) as typeof fs.writeFile;

  mutable.rename = ((src: fs.PathLike, dest: fs.PathLike, callback: (err: NodeJS.ErrnoException | null) => void) => {
    try {
      if (prepareRename(src, dest)) {
        callback(null);
        return;
      }
    } catch (error) {
      callback(error as NodeJS.ErrnoException);
      return;
    }
    rename(src, dest, callback);
  }) as typeof fs.rename;

  mutablePromises.readFile = (async (file: fs.PathLike, options?: unknown) => {
    const data = await promiseReadFile(file, options as never);
    if (!isRuntimeConfigPath(file)) return data;
    return overlayFileData(data, options);
  }) as typeof promises.readFile;

  mutablePromises.writeFile = (async (file: fs.PathLike, data: unknown, options?: unknown) => {
    if (!isRuntimeConfigPath(file)) {
      await promiseWriteFile(file, data as string | Buffer, options as never);
      return;
    }
    const next = restoreAgainst(file, data);
    if (matchesDisk(file, next)) return;
    await promiseWriteFile(file, next as string | Buffer, options as never);
  }) as typeof promises.writeFile;

  mutablePromises.rename = (async (src: fs.PathLike, dest: fs.PathLike) => {
    if (prepareRename(src, dest)) return;
    await promiseRename(src, dest);
  }) as typeof promises.rename;
}
