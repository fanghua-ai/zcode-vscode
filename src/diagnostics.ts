import * as fs from "fs";
import * as path from "path";

/** Only version metadata is read, never desktop settings or credentials. */
export function desktopVersion(binaryPath: string): string | null {
  if (!binaryPath) return null;
  const resources = path.dirname(path.dirname(binaryPath));
  try {
    const unpacked = path.join(resources, "app", "package.json");
    if (fs.existsSync(unpacked)) return validVersion(JSON.parse(fs.readFileSync(unpacked, "utf8")).version);
    const fd = fs.openSync(path.join(resources, "app.asar"), "r");
    try {
      const head = Buffer.alloc(16);
      if (fs.readSync(fd, head, 0, 16, 0) !== 16) return null;
      const size = head.readUInt32LE(12);
      if (!size || size > 8 * 1024 * 1024) return null;
      const bytes = Buffer.alloc(size);
      if (fs.readSync(fd, bytes, 0, size, 16) !== size) return null;
      const entry = JSON.parse(bytes.toString()).files?.["package.json"];
      if (!entry || entry.unpacked || !Number.isSafeInteger(entry.size) || entry.size > 65536) return null;
      const offset = Number(entry.offset);
      if (!Number.isSafeInteger(offset) || offset < 0) return null;
      const data = Buffer.alloc(entry.size);
      if (fs.readSync(fd, data, 0, data.length, 8 + head.readUInt32LE(4) + offset) !== data.length) return null;
      return validVersion(JSON.parse(data.toString()).version);
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

function validVersion(value: unknown): string | null {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value) ? value : null;
}

export function redactHome(value: string, home: string, platform = process.platform): string {
  if (!home) return value;
  const prefix = value.slice(0, home.length);
  const same = platform === "win32" ? prefix.toLowerCase() === home.toLowerCase() : prefix === home;
  return same && (!value[home.length] || /[\\/]/.test(value[home.length])) ? "~" + value.slice(home.length) : value;
}

export type IssueCategory = "synchronization" | "storage" | "authentication" | "startup" | "request";
export function issueCategory(message: string): IssueCategory {
  if (/sync|snapshot|同步|快照/i.test(message)) return "synchronization";
  if (/sqlite|WAL|数据库|索引/i.test(message)) return "storage";
  if (/auth|credential|登录|凭据/i.test(message)) return "authentication";
  if (/start|exited|module|启动|退出/i.test(message)) return "startup";
  return "request";
}
