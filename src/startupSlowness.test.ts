import assert from "node:assert/strict";
import test from "node:test";
import { defenderExclusionCommand, isSlowWindowsStartup, pluginScanFolders } from "./startupSlowness";

test("only a slow Windows startup restore asks about Defender", () => {
  assert.equal(isSlowWindowsStartup("win32", { kind: "open", "session/resume": 43429 }), true);
  assert.equal(isSlowWindowsStartup("win32", { kind: "open", "session/resume": 901 }), false);
  assert.equal(isSlowWindowsStartup("win32", { kind: "switch", "session/resume": 43429 }), false);
  assert.equal(isSlowWindowsStartup("linux", { kind: "open", "session/resume": 43429 }), false);
  // A network-bound login without a slow restore is not the plugin scan.
  assert.equal(isSlowWindowsStartup("win32", { kind: "open", totalMs: 60000 }), false);
});

test("exclusion command lists existing scan folders with PowerShell quoting", () => {
  const folders = pluginScanFolders("D:\\Zed's\\resources\\glm\\zcode.cjs", "C:\\Users\\user_", () => true);
  assert.deepEqual(folders, ["D:\\Zed's\\resources\\glm\\packages", "C:\\Users\\user_\\.zcode\\cli\\plugins"]);
  assert.deepEqual(pluginScanFolders("D:\\ZCode\\resources\\glm\\zcode.cjs", "C:\\Users\\u", (p) => p.endsWith("plugins")),
    ["C:\\Users\\u\\.zcode\\cli\\plugins"]);
  const list = "'D:\\Zed''s\\resources\\glm\\packages','C:\\Users\\user_\\.zcode\\cli\\plugins'";
  assert.equal(defenderExclusionCommand(folders, "note", "undo"),
    `# note\nAdd-MpPreference -ExclusionPath ${list}\n# undo\n# Remove-MpPreference -ExclusionPath ${list}\n`);
});
