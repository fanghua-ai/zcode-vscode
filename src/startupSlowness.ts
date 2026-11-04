import * as path from "path";

/** Cold restores slower than this are well past the ~1s warm path seen on Windows. */
export const SLOW_RESUME_MS = 20_000;

export function isSlowWindowsStartup(
  platform: NodeJS.Platform,
  timing: Record<string, string | number | boolean>
): boolean {
  const resume = timing["session/resume"];
  return platform === "win32" && timing.kind === "open" && typeof resume === "number" && resume >= SLOW_RESUME_MS;
}

/** Folders the app-server reads synchronously while it prepares plugins for a restore. */
export function pluginScanFolders(binaryPath: string, home: string, exists: (p: string) => boolean): string[] {
  return [
    path.win32.join(path.win32.dirname(binaryPath), "packages"),
    path.win32.join(home, ".zcode", "cli", "plugins"),
  ].filter(exists);
}

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

export function defenderExclusionCommand(folders: readonly string[], comment: string, undo: string): string {
  const list = folders.map(quote).join(",");
  return `# ${comment}\nAdd-MpPreference -ExclusionPath ${list}\n# ${undo}\n# Remove-MpPreference -ExclusionPath ${list}\n`;
}
