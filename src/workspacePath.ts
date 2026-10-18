import * as path from "path";

/** Windows directories are case insensitive; POSIX directories are not. */
export function workspacePathKey(value: string, platform = process.platform): string {
  if (platform !== "win32") return value;
  const normalized = path.win32.normalize(value.replace(/\//g, "\\"));
  const root = path.win32.parse(normalized).root;
  return (normalized.length > root.length ? normalized.replace(/\\+$/, "") : normalized).toLowerCase();
}

export function sameWorkspacePath(a: string, b: string, platform = process.platform): boolean {
  return workspacePathKey(a, platform) === workspacePathKey(b, platform);
}

/** Retain the desktop's spelling: its session list still compares raw strings. */
export function preferredWorkspacePath(value: string, recentProjects: string[] = [], platform = process.platform): string {
  if (platform !== "win32") return value;
  const registered = (Array.isArray(recentProjects) ? recentProjects : []).find(p => typeof p === "string" && sameWorkspacePath(p, value, platform));
  if (registered) return registered;
  return path.win32.normalize(value).replace(/^[a-z]:/, drive => drive.toUpperCase());
}
