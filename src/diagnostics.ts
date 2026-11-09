import * as fs from "fs";
import * as path from "path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isOrganizationField, isSensitiveField, redactOrganizations, redactSecrets } from "./redact";

type DiagnosticField = string | number | boolean | null | undefined;
const diagnosticEvents: Array<Record<string, DiagnosticField>> = [];

/** Callers pass only fixed labels, validated codes and presence flags. */
export function recordDiagnosticEvent(event: string, fields: Record<string, DiagnosticField>): void {
  diagnosticEvents.push({ at: new Date().toISOString(), event, ...fields });
  if (diagnosticEvents.length > 24) diagnosticEvents.shift();
}

export function recentDiagnosticEvents(): ReadonlyArray<Readonly<Record<string, DiagnosticField>>> {
  return diagnosticEvents.slice();
}

export function modelFailureDetails(error: {
  code?: unknown; source?: unknown; recoverable?: unknown; message?: unknown;
} | null | undefined) {
  return {
    code: typeof error?.code === "string" && /^(?:fault\.[a-zA-Z0-9_.]{1,90}|PROVIDER_BUSINESS_ERROR)$/.test(error.code) ? error.code : undefined,
    source: error?.source === "provider" || error?.source === "network" || error?.source === "runtime" ? error.source : undefined,
    recoverable: typeof error?.recoverable === "boolean" ? error.recoverable : undefined,
    reason: typeof error?.message === "string" && /blocked due to unusual activity/i.test(error.message)
      ? "provider_activity_block" : undefined,
  };
}

/** Only version metadata is read, never desktop settings or credentials. */
export function desktopVersion(binaryPath: string): string | null {
  if (!binaryPath) return null;
  const resources = path.dirname(path.dirname(binaryPath));
  for (const directory of ["app", "app.asar", "app.asar.unpacked"]) {
    try {
      const manifest = fs.readFileSync(path.join(resources, directory, "package.json"), "utf8");
      const version = validVersion(JSON.parse(manifest.replace(/^\uFEFF/, "")).version);
      if (version) return version;
    } catch { /* Electron ASAR paths are only readable through Electron's fs. */ }
  }
  try {
    const fd = fs.openSync(path.join(resources, "app.asar"), "r");
    try {
      const head = Buffer.alloc(16);
      if (fs.readSync(fd, head, 0, 16, 0) !== 16) return null;
      const size = head.readUInt32LE(12);
      const dataStart = 8 + head.readUInt32LE(4);
      const archiveSize = fs.fstatSync(fd).size;
      // Desktop packages can carry more than 8 MiB of ASAR file metadata.
      if (!size || size > 32 * 1024 * 1024 || 16 + size > dataStart || dataStart > archiveSize) return null;
      const bytes = Buffer.alloc(size);
      if (fs.readSync(fd, bytes, 0, size, 16) !== size) return null;
      const entry = JSON.parse(bytes.toString()).files?.["package.json"];
      if (!entry || entry.unpacked || !Number.isSafeInteger(entry.size) || entry.size > 65536) return null;
      const offset = Number(entry.offset);
      if (!Number.isSafeInteger(offset) || offset < 0 || entry.size < 0 || offset > archiveSize - dataStart - entry.size) return null;
      const data = Buffer.alloc(entry.size);
      if (fs.readSync(fd, data, 0, data.length, dataStart + offset) !== data.length) return null;
      return validVersion(JSON.parse(data.toString()).version);
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

const execFileAsync = promisify(execFile);

async function windowsExecutableVersions(executable: string): Promise<string> {
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await execFileAsync(powershell, [
    "-NoProfile", "-NonInteractive", "-Command",
    "$version = (Get-Item -LiteralPath $env:ZCODE_VERSION_EXE -ErrorAction Stop).VersionInfo; $version.ProductVersion; $version.FileVersion",
  ], { env: { ...process.env, ZCODE_VERSION_EXE: executable }, windowsHide: true, timeout: 2500, maxBuffer: 4096 });
  return stdout;
}

export async function resolveDesktopVersion(binaryPath: string, platform = process.platform,
  readExecutableVersions = windowsExecutableVersions): Promise<{ appVersion: string | null; source: string }> {
  const manifestVersion = desktopVersion(binaryPath);
  if (manifestVersion) return { appVersion: manifestVersion, source: "manifest" };
  if (binaryPath && platform === "win32") {
    const resources = path.win32.dirname(path.win32.dirname(binaryPath));
    const executable = path.win32.join(path.win32.dirname(resources), "ZCode.exe");
    try {
      const versions = await readExecutableVersions(executable);
      for (const value of versions.split(/\r?\n/)) {
        const appVersion = validVersion(value.trim());
        if (appVersion) return { appVersion, source: "windows_executable" };
      }
      return { appVersion: null, source: "windows_executable_version_missing" };
    } catch {
      return { appVersion: null, source: "windows_executable_read_failed" };
    }
  }
  if (binaryPath && platform === "darwin") {
    const contents = path.dirname(path.dirname(path.dirname(binaryPath)));
    try {
      const plist = fs.readFileSync(path.join(contents, "Info.plist"), "utf8");
      const appVersion = validVersion(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1]?.trim());
      return appVersion ? { appVersion, source: "macos_bundle" } : { appVersion: null, source: "macos_bundle_version_missing" };
    } catch {
      return { appVersion: null, source: "macos_bundle_read_failed" };
    }
  }
  return { appVersion: null, source: "manifest_unavailable" };
}

function validVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const windowsBuild = /^(\d+\.\d+\.\d+)\.\d+$/.exec(value);
  return windowsBuild?.[1] ?? (/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value) ? value : null);
}

export function redactHome(value: string, home: string, platform = process.platform): string {
  if (!home) return value;
  const prefix = value.slice(0, home.length);
  const same = platform === "win32" ? prefix.toLowerCase() === home.toLowerCase() : prefix === home;
  return same && (!value[home.length] || /[\\/]/.test(value[home.length])) ? "~" + value.slice(home.length) : value;
}

/** One boundary for copied diagnostics and any future diagnostic/log exports. */
export function redactDiagnosticText(text: string, home: string, platform = process.platform): string {
  // Redact string values before serializing, so log fragments cannot introduce
  // unescaped quotes or backslashes into a copied JSON report.
  try {
    const visit = (value: unknown): unknown => typeof value === "string" ? redactDiagnosticString(value, home, platform)
      : Array.isArray(value) ? value.map(visit)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, entry]) =>
        [key, isOrganizationField(key) || isSensitiveField(key) ? "[REDACTED]" : visit(entry)])) : value;
    return redactSecrets(JSON.stringify(visit(JSON.parse(text)), null, text.includes("\n") ? 2 : undefined));
  } catch { return redactDiagnosticString(text, home, platform); }
}

function redactDiagnosticString(text: string, home: string, platform: NodeJS.Platform): string {
  let result = redactOrganizations(redactSecrets(text));
  // Include serialized Windows paths and custom home locations, anywhere in text.
  for (const variant of new Set([home, home.replace(/\\/g, "\\\\"), home.replace(/\\/g, "/")])) {
    if (!variant) continue;
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped + String.raw`(?=$|[\\/\s"'])`, platform === "win32" ? "gi" : "g"),
      match => redactHome(match, match, platform));
  }
  // Logs can contain other users' paths, including remote macOS/Windows hosts.
  return result.replace(/\/(?:Users|home)\/[^/\\\r\n"]+|\b[A-Za-z]:[\\/]+Users[\\/]+[^/\\\r\n"]+/gi,
    match => redactHome(match, match, /[A-Za-z]:/.test(match) ? "win32" : "linux"));
}

export type IssueCategory = "synchronization" | "storage" | "authentication" | "startup" | "request";
export function issueCategory(message: string): IssueCategory {
  if (/sync|snapshot|同步|快照/i.test(message)) return "synchronization";
  if (/sqlite|WAL|数据库|索引/i.test(message)) return "storage";
  if (/auth|credential|登录|凭据/i.test(message)) return "authentication";
  if (/start|exited|module|启动|退出/i.test(message)) return "startup";
  return "request";
}
