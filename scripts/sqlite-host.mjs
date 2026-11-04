import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";

const { values } = parseArgs({ options: {
  "vscode-version": { type: "string", default: "stable" },
  "vscode-executable": { type: "string" },
} });
const repo = fileURLToPath(new URL("..", import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), "zcode-sqlite-host-"));
const reportDir = path.join(repo, "test-results", "sqlite-host", values["vscode-version"], `${process.platform}-${process.arch}`);
const source = await readFile(path.join(repo, "src/taskIndex.ts"), "utf8");
const resultPath = path.join(reportDir, "results.json");
await mkdir(reportDir, { recursive: true });
await rm(resultPath, { force: true });
await rm(path.join(reportDir, "host-logs"), { recursive: true, force: true });

try {
  for (const dir of ["home", "temp", "user/User", "extensions", "host"]) await mkdir(path.join(root, dir), { recursive: true });
  // This development host has its own identity and no activation code. Nothing is installed into the user's VS Code.
  await writeFile(path.join(root, "host/package.json"), JSON.stringify({
    name: "zcode-sqlite-tests", displayName: "ZCode SQLite Tests", publisher: "fanghua",
    version: "0.0.0", engines: { vscode: "^1.106.0" },
  }));
  await writeFile(path.join(root, "user/User/settings.json"), JSON.stringify({
    "telemetry.telemetryLevel": "off", "update.mode": "none", "extensions.autoUpdate": false,
    "workbench.startupEditor": "none", "window.restoreWindows": "none",
  }));
  await build({
    entryPoints: [path.join(repo, "src/testSupport/sqliteHost.ts")],
    outfile: path.join(root, "suite.cjs"), bundle: true, platform: "node", format: "cjs",
    external: ["vscode", "node:sqlite"],
    plugins: [{ name: "sqlite-host", setup(builder) {
      builder.onResolve({ filter: /^\.\/log$/ }, args => args.importer.endsWith("taskIndex.ts")
        ? { path: "sqlite-log", namespace: "sqlite-test" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "sqlite-test" }, () => ({
        contents: 'export const logDebug=(...args)=>globalThis.__sqliteTrace?.push(["debug",...args]);export const logWarn=(...args)=>globalThis.__sqliteTrace?.push(["warn",...args]);',
      }));
    } }],
  });
  await build({ entryPoints: [path.join(repo, "src/testSupport/sqliteWriter.ts")],
    outfile: path.join(root, "writer.cjs"), bundle: true, platform: "node", format: "cjs" });
  const home = path.join(root, "home");
  const executable = values["vscode-executable"] || await downloadAndUnzipVSCode({ version: values["vscode-version"] });
  const child = spawn(executable, ["--no-sandbox", "--disable-gpu", "--disable-extensions", "--disable-updates",
    "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust",
    `--extensionDevelopmentPath=${path.join(root, "host")}`, `--extensionTestsPath=${path.join(root, "suite.cjs")}`,
    `--user-data-dir=${path.join(root, "user")}`, `--extensions-dir=${path.join(root, "extensions")}`], {
    detached: process.platform !== "win32", stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData/Roaming"),
      LOCALAPPDATA: path.join(home, "AppData/Local"), XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local/share"), XDG_CACHE_HOME: path.join(home, ".cache"),
      ZCODE_CREDENTIAL_SECRET: undefined, VSCODE_IPC_HOOK_CLI: undefined, VSCODE_CWD: undefined, ELECTRON_RUN_AS_NODE: undefined,
      SQLITE_HOST_RUN: root, SQLITE_HOST_REPORT: resultPath, SQLITE_WRITER_NODE: process.execPath,
      SQLITE_SOURCE_SHA: createHash("sha256").update(source).digest("hex"),
    },
  });
  const stopHost = () => {
    if (!child.pid) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else { try { process.kill(-child.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; } }
  };
  let stoppedAfterReport = false, timedOut = false, shutdown;
  const timeout = setTimeout(() => { timedOut = true; stopHost(); }, 120_000);
  const poll = setInterval(async () => {
    if (shutdown) return;
    let result;
    try { result = JSON.parse(await readFile(resultPath, "utf8")); } catch { return; }
    if (typeof result.passed !== "boolean" || shutdown) return;
    // macOS may keep the GUI application alive after the test runner returns. Stop only after the final
    // report exists; missing/incomplete reports still time out and failed assertions still fail below.
    shutdown = setTimeout(() => { stoppedAfterReport = true; stopHost(); }, 5_000);
  }, 250);
  let exit;
  try {
    exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, stoppedAfterReport }));
    });
  } finally { clearTimeout(timeout); clearTimeout(shutdown); clearInterval(poll); }
  assert.equal(timedOut, false, "SQLite host timed out before completing its lifecycle");
  if (!stoppedAfterReport) assert.equal(exit.code, 0, `SQLite host exited unexpectedly (${exit.signal})`);
  const results = JSON.parse(await readFile(resultPath, "utf8"));
  results.hostExit = exit;
  await writeFile(resultPath, JSON.stringify(results, null, 2));
  assert.equal(results.sourceSha, createHash("sha256").update(source).digest("hex"));
  assert.equal(results.passed, true, "SQLite host suite did not pass");
  console.log(`SQLite host report: ${resultPath}`);
} catch (e) {
  await cp(path.join(root, "user/logs"), path.join(reportDir, "host-logs"), { recursive: true }).catch(() => {});
  throw e;
} finally {
  await rm(root, { recursive: true, force: true });
}
