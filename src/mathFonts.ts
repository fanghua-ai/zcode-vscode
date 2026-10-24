import { createHash, randomBytes } from "crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "fs/promises";
import { inflateRawSync, crc32 } from "zlib";
import * as path from "path";

/** KaTeX 0.19.0 WOFF2 faces. The release asset must be rebuilt when this list changes. */
export const MATH_FONT_VERSION = "0.19.0";
export const MATH_FONTS_URL = "https://github.com/fanghua-ai/zcode-vscode/releases/download/math-fonts-0.19.0/katex-0.19.0-woff2.zip";
export const MATH_FONTS_SHA256 = "29f8a31dc193c67a0fa8ae2d08c12ca3d491456fc7bc8cfa6d0b66b2d730eab5";
export const MATH_FONT_ARCHIVE_BYTES = 1024 * 1024;

export const MATH_FONT_FACES: readonly { family: string; weight: 400 | 700; style: "normal" | "italic"; file: string }[] = [
  { family: "KaTeX_AMS", weight: 400, style: "normal", file: "KaTeX_AMS-Regular.woff2" },
  { family: "KaTeX_Caligraphic", weight: 700, style: "normal", file: "KaTeX_Caligraphic-Bold.woff2" },
  { family: "KaTeX_Caligraphic", weight: 400, style: "normal", file: "KaTeX_Caligraphic-Regular.woff2" },
  { family: "KaTeX_Fraktur", weight: 700, style: "normal", file: "KaTeX_Fraktur-Bold.woff2" },
  { family: "KaTeX_Fraktur", weight: 400, style: "normal", file: "KaTeX_Fraktur-Regular.woff2" },
  { family: "KaTeX_Main", weight: 700, style: "normal", file: "KaTeX_Main-Bold.woff2" },
  { family: "KaTeX_Main", weight: 700, style: "italic", file: "KaTeX_Main-BoldItalic.woff2" },
  { family: "KaTeX_Main", weight: 400, style: "italic", file: "KaTeX_Main-Italic.woff2" },
  { family: "KaTeX_Main", weight: 400, style: "normal", file: "KaTeX_Main-Regular.woff2" },
  { family: "KaTeX_Math", weight: 700, style: "italic", file: "KaTeX_Math-BoldItalic.woff2" },
  { family: "KaTeX_Math", weight: 400, style: "italic", file: "KaTeX_Math-Italic.woff2" },
  { family: "KaTeX_SansSerif", weight: 700, style: "normal", file: "KaTeX_SansSerif-Bold.woff2" },
  { family: "KaTeX_SansSerif", weight: 400, style: "italic", file: "KaTeX_SansSerif-Italic.woff2" },
  { family: "KaTeX_SansSerif", weight: 400, style: "normal", file: "KaTeX_SansSerif-Regular.woff2" },
  { family: "KaTeX_Script", weight: 400, style: "normal", file: "KaTeX_Script-Regular.woff2" },
  { family: "KaTeX_Size1", weight: 400, style: "normal", file: "KaTeX_Size1-Regular.woff2" },
  { family: "KaTeX_Size2", weight: 400, style: "normal", file: "KaTeX_Size2-Regular.woff2" },
  { family: "KaTeX_Size3", weight: 400, style: "normal", file: "KaTeX_Size3-Regular.woff2" },
  { family: "KaTeX_Size4", weight: 400, style: "normal", file: "KaTeX_Size4-Regular.woff2" },
  { family: "KaTeX_Typewriter", weight: 400, style: "normal", file: "KaTeX_Typewriter-Regular.woff2" },
];

export type FormulaFontMode = "auto" | "on" | "off";

export function formulaFontMode(value: unknown): FormulaFontMode {
  return value === "on" || value === "off" ? value : "auto";
}

/** Local tests may point at a temporary server. The hash below still has to match. */
export function mathFontSourceUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ZCODE_MATH_FONTS_URL?.trim();
  return override || MATH_FONTS_URL;
}

/** Download the pinned release asset. The hash is checked before installation. */
export async function loadMathFontPack(env: NodeJS.ProcessEnv = process.env): Promise<Uint8Array> {
  return fetchMathFontPack(mathFontSourceUrl(env));
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Inline WOFF2. VS Code serves .woff2 from a webview as application/unknown, which the page will not apply. */
export function mathFontDataHref(bytes: Uint8Array): string {
  return `data:font/woff2;base64,${Buffer.from(bytes).toString("base64")}`;
}

export function mathFontFaceCss(hrefFor: (file: string) => string): string {
  return MATH_FONT_FACES.map(face => {
    const href = hrefFor(face.file);
    if (/["()\\\s<>]/.test(href)) throw new Error("formula font URI is not safe for CSS");
    return `@font-face{font-family:"${face.family}";src:url("${href}") format("woff2");font-weight:${face.weight};font-style:${face.style};font-display:swap}`;
  }).join("");
}

interface ZipEntry { name: string; data: Buffer }

/** Stored ZIP with a fixed timestamp so the release asset has a stable hash. */
export function storeZip(entries: readonly { name: string; data: Uint8Array }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const date = ((2020 - 1980) << 9) | (1 << 5) | 1;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const checksum = crc32(data) >>> 0;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export function readZip(bytes: Uint8Array): ZipEntry[] {
  if (bytes.length < 22 || bytes.length > MATH_FONT_ARCHIVE_BYTES) {
    throw Object.assign(new Error("formula font pack has an unexpected size"), { code: "ARCHIVE" });
  }
  const data = Buffer.from(bytes);
  let endOffset = -1;
  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 22 - 65535); offset--) {
    if (data.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = data.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === data.length) { endOffset = offset; break; }
  }
  if (endOffset < 0) throw Object.assign(new Error("formula font pack is truncated"), { code: "ARCHIVE" });
  const count = data.readUInt16LE(endOffset + 10);
  const directorySize = data.readUInt32LE(endOffset + 12);
  const directoryOffset = data.readUInt32LE(endOffset + 16);
  if (count === 0 || count > 32 || directoryOffset + directorySize !== endOffset) {
    throw Object.assign(new Error("formula font pack directory is invalid"), { code: "ARCHIVE" });
  }
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let cursor = directoryOffset;
  let packedEnd = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > endOffset || data.readUInt32LE(cursor) !== 0x02014b50) {
      throw Object.assign(new Error("formula font pack directory is invalid"), { code: "ARCHIVE" });
    }
    const flags = data.readUInt16LE(cursor + 8);
    const method = data.readUInt16LE(cursor + 10);
    const checksum = data.readUInt32LE(cursor + 16);
    const compressedSize = data.readUInt32LE(cursor + 20);
    const size = data.readUInt32LE(cursor + 24);
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const localOffset = data.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameLength + extraLength + commentLength > endOffset) {
      throw Object.assign(new Error("formula font pack directory is invalid"), { code: "ARCHIVE" });
    }
    const name = data.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;
    if ((flags & 0x1) !== 0 || (flags & 0x8) !== 0 || (method !== 0 && method !== 8)) {
      throw Object.assign(new Error("formula font pack entry is not supported"), { code: "ARCHIVE" });
    }
    if (seen.has(name) || size > MATH_FONT_ARCHIVE_BYTES || compressedSize > MATH_FONT_ARCHIVE_BYTES) {
      throw Object.assign(new Error("formula font pack entry is not supported"), { code: "ARCHIVE" });
    }
    if (localOffset + 30 > directoryOffset || data.readUInt32LE(localOffset) !== 0x04034b50) {
      throw Object.assign(new Error("formula font pack is truncated"), { code: "ARCHIVE" });
    }
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    const localName = data.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8");
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const end = start + compressedSize;
    if (localName !== name || end > directoryOffset || (packedEnd > 0 && localOffset < packedEnd)) {
      throw Object.assign(new Error("formula font pack entry is invalid"), { code: "ARCHIVE" });
    }
    const compressed = data.subarray(start, end);
    // Cap expansion at the declared size. The hash is pinned, but a replaced archive must not be a zip bomb.
    let content: Buffer;
    try {
      content = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: size });
    } catch {
      throw Object.assign(new Error("formula font pack entry is invalid"), { code: "ARCHIVE" });
    }
    if (content.length !== size || (crc32(content) >>> 0) !== checksum) {
      throw Object.assign(new Error("formula font pack entry checksum mismatch"), { code: "ARCHIVE" });
    }
    seen.add(name);
    packedEnd = end;
    entries.push({ name, data: content });
  }
  if (cursor !== endOffset) throw Object.assign(new Error("formula font pack directory is invalid"), { code: "ARCHIVE" });
  return entries;
}

function packError(message: string): Error {
  return Object.assign(new Error(message), { code: "ARCHIVE" });
}

function safePackEntries(entries: readonly ZipEntry[]): Map<string, Buffer> {
  const wanted = new Set(["LICENSE", "OFL.txt", ...MATH_FONT_FACES.map(face => `fonts/${face.file}`)]);
  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    const parts = entry.name.split("/");
    if (entry.name.includes("\\") || path.posix.isAbsolute(entry.name) || parts.includes("..") || parts.includes("")) {
      throw packError("formula font pack path is unsafe");
    }
    if (!wanted.has(entry.name) || files.has(entry.name)) throw packError("formula font pack contains an unexpected file");
    files.set(entry.name, entry.data);
  }
  if (files.size !== wanted.size) throw packError("formula font pack is incomplete");
  return files;
}

const TRANSIENT_INSTALL_CODES = new Set(["ENOENT", "ENOTEMPTY", "EEXIST", "EPERM", "EBUSY"]);

export async function installMathFontPack(
  bytes: Uint8Array,
  destination: string,
  expectedSha256: string,
  options: { beforeCommit?: () => Promise<void> } = {},
): Promise<void> {
  if (sha256Hex(bytes) !== expectedSha256) {
    throw Object.assign(new Error("formula font pack hash mismatch"), { code: "HASH" });
  }
  if (mathFontPackReady(destination, expectedSha256)) return;
  const files = safePackEntries(readZip(bytes));
  await mkdir(path.dirname(destination), { recursive: true });
  // A shared staging or backup directory is removed by the other window. Keep both private.
  const staging = await mkdtemp(`${destination}.staging.`);
  try {
    await mkdir(path.join(staging, "fonts"), { recursive: true });
    for (const [name, data] of files) await writeFile(path.join(staging, ...name.split("/")), data);
    await writeFile(path.join(staging, ".sha256"), `${expectedSha256}\n`);
    await options.beforeCommit?.();
    if (mathFontPackReady(destination, expectedSha256)) return;
    await commitMathFontPack(staging, destination, expectedSha256);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function installErrorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "";
}

async function commitMathFontPack(staging: string, destination: string, expectedSha256: string): Promise<void> {
  const backups: string[] = [];
  let failure: unknown;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (mathFontPackReady(destination, expectedSha256)) return;
      try {
        await rename(staging, destination);
        return;
      } catch (error) {
        if (mathFontPackReady(destination, expectedSha256)) return;
        const code = installErrorCode(error);
        failure = error;
        if (!TRANSIENT_INSTALL_CODES.has(code)) break;
        // Only an incomplete pack needs to move. A peer may already be replacing it.
        if (code !== "ENOENT") {
          const backup = `${destination}.backup.${randomBytes(8).toString("hex")}`;
          try {
            await rename(destination, backup);
            backups.push(backup);
            continue;
          } catch (moveError) {
            if (mathFontPackReady(destination, expectedSha256)) return;
            if (!TRANSIENT_INSTALL_CODES.has(installErrorCode(moveError))) {
              failure = moveError;
              break;
            }
          }
        }
        if (attempt === 4) break;
      }
      await new Promise(resolve => setTimeout(resolve, 15 * (attempt + 1)));
    }
  } finally {
    await discardInstallBackups(backups, destination, expectedSha256);
  }
  if (mathFontPackReady(destination, expectedSha256)) return;
  throw failure ?? Object.assign(new Error("formula font pack could not be installed"), { code: "INSTALL" });
}

/** Remove only backups this install created. A complete pack stays if it is the only remaining copy. */
async function discardInstallBackups(backups: readonly string[], destination: string, expectedSha256: string): Promise<void> {
  for (const backup of backups) {
    if (!existsSync(backup)) continue;
    if (mathFontPackReady(destination, expectedSha256) || !mathFontPackReady(backup, expectedSha256)) {
      await rm(backup, { recursive: true, force: true });
      continue;
    }
    if (!existsSync(destination)) {
      try { await rename(backup, destination); } catch { /* leave the complete backup beside the other install */ }
    }
  }
}

/** WOFF2 total length is stored big-endian at byte 8. Truncation or a substituted file must be redownloaded. */
function isCompleteWoff2(file: string, bytes: number): boolean {
  if (bytes < 48 || bytes > MATH_FONT_ARCHIVE_BYTES) return false;
  const fd = openSync(file, "r");
  try {
    const header = Buffer.alloc(12);
    if (readSync(fd, header, 0, 12, 0) !== 12) return false;
    return header.toString("ascii", 0, 4) === "wOF2" && header.readUInt32BE(8) === bytes;
  } finally {
    closeSync(fd);
  }
}

export function mathFontPackReady(directory: string, expectedSha256: string): boolean {
  try {
    const stamp = readFileSync(path.join(directory, ".sha256"), "utf8").trim();
    if (stamp !== expectedSha256) return false;
    return MATH_FONT_FACES.every(face => {
      const file = path.join(directory, "fonts", face.file);
      return isCompleteWoff2(file, statSync(file).size);
    });
  } catch {
    return false;
  }
}

export function buildMathFontPack(root = process.cwd()): Buffer {
  const license = readFileSync(path.join(root, "node_modules", "katex", "LICENSE"));
  const ofl = readFileSync(path.join(root, "scripts", "third-party", "OFL-1.1.txt"));
  const entries = MATH_FONT_FACES.map(face => ({
    name: `fonts/${face.file}`,
    data: readFileSync(path.join(root, "node_modules", "katex", "dist", "fonts", face.file)),
  }));
  entries.push({ name: "LICENSE", data: license }, { name: "OFL.txt", data: ofl });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return storeZip(entries);
}

export async function fetchMathFontPack(url: string, options: { maxBytes?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("formula font URL must use http or https");
  }
  const maxBytes = options.maxBytes ?? MATH_FONT_ARCHIVE_BYTES;
  const response = await (options.fetchImpl ?? fetch)(url, { redirect: "follow", signal: AbortSignal.timeout(options.timeoutMs ?? 20000) });
  if (!response.ok) throw new Error(`formula font download failed (${response.status})`);
  const declared = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("formula font download is too large");
  if (!response.body) throw new Error("formula font download was empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    size += step.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("formula font download is too large");
    }
    chunks.push(step.value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
