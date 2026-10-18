import { hostT as t } from "./hostI18n";
import { LocalizedError } from "./i18n";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const UNINSTALL_KEYS = [
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];

export interface ServerPathDeps {
  exists?: (filePath: string) => boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  readFile?: (filePath: string) => string | null;
  listDir?: (dir: string) => string[] | null;
  run?: (command: string, args: string[]) => Promise<string>;
  installRoots?: () => Promise<string[]>;
  /** Last path that successfully started app-server. Checked before any search. */
  preferred?: string;
}

export interface UninstallEntry {
  displayName: string;
  installLocation: string;
  displayIcon: string;
}

export function defaultCandidatePaths(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homedir: string
): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
      path.join(homedir, "Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"),
    ];
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? "";
    return [path.win32.join(local, "Programs", "ZCode", "resources", "glm", "zcode.cjs")];
  }
  return [
    "/opt/ZCode/resources/glm/zcode.cjs",
    "/usr/lib/zcode/resources/glm/zcode.cjs",
    path.join(homedir, ".local/share/ZCode/resources/glm/zcode.cjs"),
  ];
}

export function appServerEntry(installRoot: string, platform: NodeJS.Platform): string {
  const joiner = platform === "win32" ? path.win32 : path.posix;
  if (platform === "darwin" && installRoot.endsWith(".app")) {
    return joiner.join(installRoot, "Contents", "Resources", "glm", "zcode.cjs");
  }
  return joiner.join(installRoot, "resources", "glm", "zcode.cjs");
}

export function installRootFromUninstallFields(fields: {
  installLocation?: string;
  displayIcon?: string;
}): string | null {
  const location = fields.installLocation?.trim();
  if (location) return location.replace(/[\\/]+$/, "");
  const icon = fields.displayIcon?.trim().replace(/^"|"$/g, "");
  if (!icon) return null;
  const file = icon.split(",")[0].trim();
  if (!path.win32.isAbsolute(file)) return null;
  return path.win32.dirname(file);
}

export function parseUninstallRegistry(text: string): UninstallEntry[] {
  const entries: UninstallEntry[] = [];
  let current: UninstallEntry | null = null;
  const flush = () => {
    if (current?.displayName) entries.push(current);
    current = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (/^HKEY_/.test(line.trim())) {
      flush();
      current = { displayName: "", installLocation: "", displayIcon: "" };
      continue;
    }
    if (!current) continue;
    const match = line.match(/^\s*(DisplayName|InstallLocation|DisplayIcon)\s+REG_\w+\s+(.*)$/);
    if (!match) continue;
    const value = match[2].trim();
    if (match[1] === "DisplayName") current.displayName = value;
    if (match[1] === "InstallLocation") current.installLocation = value;
    if (match[1] === "DisplayIcon") current.displayIcon = value;
  }
  flush();
  return entries;
}

export function rootsFromUninstallRegistry(text: string): string[] {
  const roots: string[] = [];
  for (const entry of parseUninstallRegistry(text)) {
    if (!/^zcode\b/i.test(entry.displayName)) continue;
    const root = installRootFromUninstallFields(entry);
    if (root && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

export function parseDesktopExec(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^Exec=(.*)$/);
    if (!match) continue;
    const raw = match[1].trim();
    if (raw.startsWith('"')) {
      const end = raw.indexOf('"', 1);
      return end > 1 ? raw.slice(1, end) : null;
    }
    const token = raw.split(/\s+/)[0];
    return token || null;
  }
  return null;
}

export function candidatesFromExecutable(
  execPath: string,
  platform: NodeJS.Platform
): string[] {
  if (/(^|[\\/])zcode\.cjs$/i.test(execPath)) return [execPath];
  const joiner = platform === "win32" ? path.win32 : path.posix;
  const root = joiner.dirname(execPath);
  const found = [appServerEntry(root, platform)];
  if (platform === "darwin") {
    const app = execPath.replace(/\/Contents\/MacOS\/[^/]+$/, "");
    if (app.endsWith(".app")) found.push(appServerEntry(app, "darwin"));
  }
  return found;
}

export function linuxDesktopDirs(homedir: string, env: NodeJS.ProcessEnv): string[] {
  const user = env.XDG_DATA_HOME || path.join(homedir, ".local", "share");
  const system = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share")
    .split(path.delimiter)
    .filter(Boolean);
  return [
    user,
    ...system,
    "/var/lib/flatpak/exports/share",
    path.join(homedir, ".local", "share", "flatpak", "exports", "share"),
    "/var/lib/snapd/desktop",
  ].map((dir) => path.join(dir, "applications"));
}

export function appServerLaunch(input: {
  binaryPath: string;
  nodePath?: string;
  execPath: string;
}): { command: string; args: string[]; electronAsNode: boolean } {
  const script = input.binaryPath.endsWith(".cjs") || input.binaryPath.endsWith(".js");
  if (!script) {
    return { command: input.binaryPath, args: ["app-server"], electronAsNode: false };
  }
  const nodePath = input.nodePath?.trim() || "";
  if (nodePath) {
    return { command: nodePath, args: [input.binaryPath, "app-server"], electronAsNode: false };
  }
  return {
    command: input.execPath,
    args: [input.binaryPath, "app-server"],
    electronAsNode: true,
  };
}

export function startupExitMessage(input: {
  stderr?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  binaryPath?: string;
  command?: string;
  spawnCode?: string;
}): string {
  if (input.spawnCode === "ENOENT") {
    return t("无法启动 ZCode app-server：找不到命令 {0}。请安装 Node.js，或在设置里填写 zcode.nodePath。", { 0: input.command || "node" });
  }
  const stderr = input.stderr || "";
  const missing = stderr.match(/Cannot find module ['"]([^'"]+)['"]/);
  if (missing) {
    return t("找不到 ZCode app-server 文件，安装路径无效：{0}。请在设置里填写 zcode.binaryPath。", { 0: missing[1] });
  }
  const tail = stderr.trim().split(/\r?\n/).slice(-3).join(" ");
  const status =
    input.signal && input.code == null
      ? t("信号 {0}", { 0: input.signal })
      : t("退出码 {0}", { 0: input.code ?? t("未知") });
  return t("ZCode app-server 在就绪前退出（{0}）。{1}", { 0: status, 1: tail }).trim();
}

async function findWindowsInstallRoots(): Promise<string[]> {
  const roots: string[] = [];
  for (const key of UNINSTALL_KEYS) {
    try {
      const { stdout } = await execFileAsync("reg.exe", ["query", key, "/s"], {
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
      for (const root of rootsFromUninstallRegistry(stdout)) {
        if (!roots.includes(root)) roots.push(root);
      }
    } catch {
      // This hive may be absent.
    }
  }
  return roots;
}

export async function locateAppServer(
  configured: string | undefined,
  deps: ServerPathDeps = {}
): Promise<string> {
  const exists = deps.exists ?? fs.existsSync;
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const homedir = deps.homedir ?? os.homedir();
  const explicit = configured?.trim() || "";
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!exists(resolved)) {
      throw new LocalizedError("已设置的 zcode.binaryPath 不存在：{0}", { 0: resolved });
    }
    return resolved;
  }

  const checked: string[] = [];
  const take = (candidate: string): string | null => {
    if (!candidate || checked.includes(candidate)) return null;
    checked.push(candidate);
    return exists(candidate) ? candidate : null;
  };

  const remembered = deps.preferred?.trim() || "";
  if (remembered) {
    const found = take(path.resolve(remembered));
    if (found) return found;
  }

  for (const candidate of defaultCandidatePaths(platform, env, homedir)) {
    const found = take(candidate);
    if (found) return found;
  }

  if (platform === "win32") {
    const roots = await (deps.installRoots ?? findWindowsInstallRoots)();
    for (const root of roots) {
      const found = take(appServerEntry(root, "win32"));
      if (found) return found;
    }
  } else if (platform === "linux") {
    const readFile = deps.readFile ?? readTextIfExists;
    const listDir = deps.listDir ?? listDirectory;
    for (const dir of linuxDesktopDirs(homedir, env)) {
      const names = listDir(dir) ?? [];
      for (const name of names) {
        if (!/zcode/i.test(name) || !name.endsWith(".desktop")) continue;
        const text = readFile(path.join(dir, name));
        const execPath = text ? parseDesktopExec(text) : null;
        if (!execPath) continue;
        for (const candidate of candidatesFromExecutable(execPath, "linux")) {
          const found = take(candidate);
          if (found) return found;
        }
      }
    }
  } else if (platform === "darwin") {
    const run = deps.run ?? runCommand;
    try {
      const output = await run("mdfind", ["kMDItemFSName == 'ZCode.app'"]);
      for (const line of output.split(/\r?\n/)) {
        const app = line.trim();
        if (!app) continue;
        const found = take(appServerEntry(app, "darwin"));
        if (found) return found;
      }
    } catch {
      // Spotlight may be unavailable.
    }
  }

  throw new LocalizedError(
    "找不到 ZCode app-server。已检查：{0}。请在设置中填写 zcode.binaryPath。",
    { 0: checked.join("; ") || t("无默认路径") }
  );
}

function readTextIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function listDirectory(dir: string): string[] | null {
  try {
    return fs.readdirSync(dir);
  } catch {
    return null;
  }
}

async function runCommand(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}
