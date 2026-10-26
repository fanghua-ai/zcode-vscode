import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { build } from "esbuild";

const { values } = parseArgs({ options: {
  "vscode-version": { type: "string", default: "stable" },
  "vscode-executable": { type: "string" },
} });
const repo = fileURLToPath(new URL("..", import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), "zcode-clipboard-host-"));
const output = path.join(repo, "test-results/clipboard-host", values["vscode-version"], `${process.platform}-${process.arch}`);
const events = path.join(root, "events.jsonl");
const checks = [];
const connections = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, inner, launchError, timedOut = false, hostLog = "", requestId = 0, timer;
await mkdir(output, { recursive: true });
await rm(path.join(output, "results.json"), { force: true });

async function until(operation, description, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await operation();
    if (value) return value;
    if (launchError) throw launchError;
    if (timedOut || child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`Host exited while waiting for ${description}`);
    await pause(50);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}

async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let next = 0;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Debugger connection timed out")), 10_000);
    socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener("error", error => { clearTimeout(timeout); reject(error); }, { once: true });
  });
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data)), slot = pending.get(message.id);
    if (!slot) return;
    clearTimeout(slot.timer); pending.delete(message.id);
    if (message.error) slot.reject(new Error(JSON.stringify(message.error)));
    else slot.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const slot of pending.values()) { clearTimeout(slot.timer); slot.reject(new Error("Debugger disconnected")); }
    pending.clear();
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10_000);
    pending.set(id, { resolve, reject, timer: timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    if (typeof expression === "function") expression = `(${expression.toString()})()`;
    const result = await rpc("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description);
    return result.result.value;
  };
  const connection = { socket, rpc, evaluate };
  connections.push(connection);
  return connection;
}

function inPage(operation, ...args) {
  return inner.evaluate(`(${operation.toString()})(document.querySelector('iframe')?.contentDocument,...${JSON.stringify(args)})`);
}

async function hostRequest(type, extra = {}) {
  const id = ++requestId;
  await inPage((document, message) => document.defaultView.clipboardTestApi.postMessage(message), { type: `clipboard_test_${type}`, id, ...extra });
  return until(async () => {
    let text;
    try { text = await readFile(events, "utf8"); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    const complete = text.slice(0, text.lastIndexOf("\n"));
    const result = complete.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(row => row.id === id);
    if (result?.error) throw new Error(result.error);
    return result;
  }, `host ${type} response`);
}

async function click(connection, point, button = "left", clickCount = 1) {
  await connection.rpc("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  for (const type of ["mousePressed", "mouseReleased"]) {
    await connection.rpc("Input.dispatchMouseEvent", { type, ...point, button, clickCount,
      buttons: type === "mouseReleased" ? 0 : button === "right" ? 2 : 1 });
  }
}

async function keyboardCopy() {
  for (const type of ["keyDown", "keyUp"]) {
    await inner.rpc("Input.dispatchKeyEvent", { type, key: "c", code: "KeyC",
      windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67, modifiers: process.platform === "darwin" ? 4 : 2 });
  }
}

async function checkClipboard(action, expected, before) {
  let last;
  try {
    await until(async () => {
      last = await hostRequest("read", { expected });
      return last.matches;
    }, `${action} to update the OS clipboard`, 3000);
  } catch (error) {
    const after = await inPage(document => ({ active: document.activeElement.id || document.activeElement.tagName,
      selectionLength: document.getSelection().toString().length }));
    throw new Error(`${error.message}: ${JSON.stringify({ before, after, clipboard: last })}`);
  }
  checks.push({ action, expectedLength: expected.length, matches: true });
}

try {
  for (const directory of ["home", "temp", "user/User", "extensions", "host"]) await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, "host/package.json"), JSON.stringify({ name: "zcode-clipboard-tests", publisher: "fanghua",
    version: "0.0.0", engines: { vscode: "^1.106.0" }, activationEvents: ["*"], main: "main.cjs" }));
  await writeFile(path.join(root, "user/User/settings.json"), JSON.stringify({
    "telemetry.telemetryLevel": "off", "update.mode": "none", "extensions.autoUpdate": false,
    "workbench.startupEditor": "none", "window.restoreWindows": "none", "security.workspace.trust.enabled": false,
  }));
  await build({ entryPoints: [path.join(repo, "src/testSupport/clipboardHost.ts")], outfile: path.join(root, "host/main.cjs"),
    bundle: true, platform: "node", format: "cjs", external: ["vscode"] });
  const executable = values["vscode-executable"] || await downloadAndUnzipVSCode({ version: values["vscode-version"] });
  const home = path.join(root, "home");
  child = spawn(executable, ["--no-sandbox", "--disable-gpu", "--disable-extensions", "--skip-welcome", "--skip-release-notes",
    "--disable-workspace-trust", "--locale=en", "--remote-debugging-port=0",
    `--user-data-dir=${path.join(root, "user")}`, `--extensions-dir=${path.join(root, "extensions")}`,
    `--extensionDevelopmentPath=${path.join(root, "host")}`], {
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: {
      ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData/Roaming"),
      LOCALAPPDATA: path.join(home, "AppData/Local"), XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local/share"), XDG_CACHE_HOME: path.join(home, ".cache"),
      ZCODE_CLIPBOARD_REPO: repo, ZCODE_CLIPBOARD_EVENTS: events, ZCODE_CREDENTIAL_SECRET: undefined,
      VSCODE_IPC_HOOK_CLI: undefined, VSCODE_CWD: undefined, ELECTRON_RUN_AS_NODE: undefined,
    },
  });
  child.on("error", error => { launchError = error; hostLog += String(error); });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { hostLog += data.toString(); });
  timer = setTimeout(() => { timedOut = true; stopHost(); }, 120_000);
  const endpoint = await until(() => hostLog.match(/DevTools listening on (ws:\/\/\S+)/)?.[1], "debugger endpoint", 30_000);
  const port = new URL(endpoint).port;
  const targets = await until(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const webview = pages.find(page => page.type === "iframe" && page.url.includes("extensionId=fanghua.zcode-clipboard-tests"));
    const workbench = pages.find(page => page.type === "page");
    return webview && workbench ? { webview, workbench } : undefined;
  }, "real webview", 30_000);
  inner = await connect(targets.webview);
  const top = await connect(targets.workbench);
  await until(() => inPage(document => !!document?.querySelector(".message.assistant .md p")), "reply fixture");
  // Test production HTML as-is: never set tabindex or repair focus in the driver.
  for (const action of ["keyboard", "context-menu"]) for (let index = 0; index < 2; index++) {
    const point = await inPage((document, index) => {
      document.querySelector("#input").focus();
      const rect = document.querySelectorAll(".message.assistant .md p")[index].getBoundingClientRect();
      return { x: rect.x + 45, y: rect.y + rect.height / 2 };
    }, index);
    await click(inner, point, "left", 3);
    const before = await inPage(document => ({ active: document.activeElement.id || document.activeElement.tagName,
      text: document.getSelection().toString() }));
    assert.ok(before.text.includes(index ? "SECOND_COPY_SENTINEL" : "FIRST_COPY_SENTINEL"), "Mouse input did not select the fixture");
    await hostRequest("seed");
    if (action === "keyboard") await keyboardCopy();
    else {
      await click(inner, point, "right");
      const copyPoint = await until(() => top.evaluate(async () => {
        const item = [...document.querySelectorAll(".monaco-menu .action-label")].find(node => node.textContent.trim() === "Copy");
        if (!item?.closest(".monaco-menu")?.contains(document.activeElement) || item.closest(".disabled")) return null;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const rect = item.getBoundingClientRect();
        const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        return item.closest(".action-item")?.contains(document.elementFromPoint(point.x, point.y)) ? point : null;
      }), "native Copy menu item");
      // An immediate pointer click during menu opening can dismiss it without
      // activating an item. Move onto Copy, then let the opening gesture settle.
      await top.rpc("Input.dispatchMouseEvent", { type: "mouseMoved", ...copyPoint });
      await pause(200);
      await click(top, copyPoint);
    }
    await checkClipboard(`${action}-${index + 1}`, before.text, before);
  }
  const composerText = "COMPOSER_COPY_SENTINEL";
  await inPage((document, text) => {
    const input = document.querySelector("#input");
    input.focus(); input.value = text; input.select();
  }, composerText);
  await hostRequest("seed");
  await keyboardCopy();
  await checkClipboard("composer", composerText);
  const host = (await readFile(events, "utf8")).trim().split("\n").map(line => JSON.parse(line)).find(row => row.type === "host");
  const sources = {};
  for (const source of ["src/webviewHtml.ts", "src/webview/main.ts"]) sources[source] = createHash("sha256").update(await readFile(path.join(repo, source))).digest("hex");
  await writeFile(path.join(output, "results.json"), JSON.stringify({ passed: true, host, sources, checks }, null, 2));
  console.log(`Clipboard host passed: ${checks.length} real OS clipboard checks (${host.vscode}, ${host.platform}-${host.arch}).`);
} catch (error) {
  await writeFile(path.join(output, "results.json"), JSON.stringify({ passed: false, error: String(error), checks }, null, 2));
  await cp(path.join(root, "user/logs"), path.join(output, "host-logs"), { recursive: true }).catch(() => {});
  throw error;
} finally {
  clearTimeout(timer);
  if (inner && child?.exitCode === null) await hostRequest("restore").catch(() => {});
  for (const connection of connections) connection.socket.close();
  await writeFile(path.join(output, "host.log"), hostLog);
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.once("exit", resolve));
    stopHost();
    await Promise.race([exited, pause(3000)]);
    if (child.exitCode === null && child.signalCode === null) stopHost("SIGKILL");
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function stopHost(signal = "SIGTERM") {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; } }
}
