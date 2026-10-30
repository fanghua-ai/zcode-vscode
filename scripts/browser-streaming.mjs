import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

// Exercise the built page with a fake VS Code bridge, no desktop or account.
// Controlled frames prove coalescing; a final scenario uses the browser's rAF.
const root = await mkdtemp(path.join(tmpdir(), "zcode-browser-streaming-"));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let chrome, socket;
try {
  const modulePath = path.join(root, "html.cjs");
  await build({ entryPoints: ["src/webviewHtml.ts"], outfile: modulePath, bundle: true,
    platform: "node", format: "cjs", alias: { vscode: path.resolve("src/testSupport/vscode.ts") } });
  const { getWebviewHtml } = createRequire(import.meta.url)(modulePath);
  let html = getWebviewHtml({ cspSource: "file:", asWebviewUri: uri => uri }, pathToFileURL(process.cwd()).href, "streaming");
  const start = html.indexOf("<script");
  html = html.slice(0, start) + `<script nonce="streaming">
    window.sent=[];window.savedState={};window.errors=[];
    window.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>savedState,setState:s=>savedState=s});
    window.addEventListener('error',e=>errors.push(e.message));
    window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    const nativeRequestFrame=window.requestAnimationFrame.bind(window);
    const nativeCancelFrame=window.cancelAnimationFrame.bind(window);
    const frames=new Map();let frameId=0;
    window.requestAnimationFrame=callback=>{const id=++frameId;frames.set(id,callback);return id;};
    window.cancelAnimationFrame=id=>frames.delete(id);
    window.stepFrame=()=>{const current=[...frames];frames.clear();for(const [,callback] of current)callback(performance.now());};
    window.useNativeFrames=()=>{frames.clear();window.requestAnimationFrame=nativeRequestFrame;window.cancelAnimationFrame=nativeCancelFrame;};
  </script>` + html.slice(start);
  const file = path.join(root, "streaming.html");
  await writeFile(file, html);
  chrome = spawn(process.env.CHROME_BIN || "google-chrome", ["--headless", "--no-sandbox", "--disable-gpu",
    "--disable-background-networking", "--no-first-run", "--remote-debugging-port=0",
    `--user-data-dir=${path.join(root, "profile")}`, pathToFileURL(file).href], { stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Browser did not start")), 10000);
    chrome.once("error", error => { clearTimeout(timer); reject(error); });
    chrome.stderr.on("data", data => {
      output += data;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const port = new URL(endpoint).port;
  let target;
  for (let attempt = 0; attempt < 50 && !target; attempt++) {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = pages.find(page => page.type === "page" && page.url === pathToFileURL(file).href);
    if (!target) await pause(100);
  }
  assert.ok(target, "Streaming page missing");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let next = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    const slot = pending.get(message.id);
    if (!slot) return;
    clearTimeout(slot.timer); pending.delete(message.id);
    if (message.error) slot.reject(new Error(JSON.stringify(message.error)));
    else slot.resolve(message.result);
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await rpc("Runtime.enable");
  for (let attempt = 0; ; attempt++) {
    const result = await rpc("Runtime.evaluate", { expression: "document.readyState === 'complete' && window.sent.some(m=>m.type==='ready')", returnByValue: true });
    if (result.result.value) break;
    if (attempt === 99) throw new Error("Webview did not become ready");
    await pause(50);
  }
  const result = await rpc("Runtime.evaluate", { awaitPromise: true, returnByValue: true,
    expression: `(${runScenarios.toString()})()` });
  assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description);
  assert.ok(result.result.value.checks >= 30);
  console.log(`Browser streaming passed: ${result.result.value.checks} checks (coalescing, event order, completion, resets, escaping and native rAF).`);
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise(resolve => chrome.once("exit", resolve));
    chrome.kill("SIGTERM");
    await Promise.race([exited, pause(2000)]);
    if (chrome.exitCode === null) { chrome.kill("SIGKILL"); await Promise.race([exited, pause(2000)]); }
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function runScenarios() {
  let checks = 0, generation = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const emit = data => window.dispatchEvent(new MessageEvent("message", { data }));
  const messages = document.getElementById("messages");
  const body = part => [...messages.querySelectorAll(".message.assistant")].find(node => node.dataset.partId === part);
  const delta = (partId, fullText, extra = {}) => emit({ type: "assistant_text_delta", partId, fullText, ...extra });
  const drainFrames = () => { for (let index = 0; index < 4; index++) window.stepFrame(); };
  const ready = (sessionId = "stream-test") => {
    emit({ type: "view_reset", clear: true, viewGen: ++generation });
    emit({ type: "session_ready", sessionId, viewGen: generation });
    emit({ type: "history", sessionId, viewGen: generation, items: [] });
    emit({ type: "stream_release" });
    drainFrames();
  };

  ready();
  delta("batch", "Start"); window.stepFrame();
  const bubble = body("batch"), markdown = bubble.querySelector(".md");
  const observer = new MutationObserver(() => {});
  observer.observe(bubble, { childList: true });
  for (let index = 1; index <= 100; index++) delta("batch", "Start" + " increment".repeat(index));
  check(bubble.querySelector(".md") === markdown, "same-frame deltas rebuilt Markdown before the frame");
  check(observer.takeRecords().length === 0, "same-frame deltas mutated the bubble before the frame");
  window.stepFrame();
  check(body("batch") === bubble, "coalescing replaced the message bubble");
  check(bubble.dataset.copyText === "Start" + " increment".repeat(100), "coalescing lost the latest text");
  check(observer.takeRecords().filter(record => record.removedNodes.length > 0).length === 1,
    "a batch rendered more than once in one frame");
  observer.disconnect();
  delta("batch", "Start"); window.stepFrame();
  check(bubble.dataset.copyText.endsWith(" increment".repeat(100)), "a replayed prefix shrank the message");

  ready();
  delta("first", "FIRST_PART"); delta("second", "SECOND_PART");
  window.stepFrame();
  check(body("first")?.dataset.copyText === "FIRST_PART", "part switch lost the pending first part");
  check(body("second")?.dataset.copyText === "SECOND_PART", "part switch lost the second part");
  check(!!(body("first").compareDocumentPosition(body("second")) & Node.DOCUMENT_POSITION_FOLLOWING),
    "part switch reversed the message order");

  ready();
  delta("before-tool", "BEFORE_TOOL");
  emit({ type: "tool_call", toolCallId: "stream-tool", toolName: "read", status: "running", inputText: "test.txt" });
  check(body("before-tool")?.dataset.copyText === "BEFORE_TOOL", "tool event overtook pending narration");
  const tool = document.getElementById("tool-stream-tool");
  check(!!(body("before-tool").compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING),
    "narration rendered after its tool");
  delta("after-tool", "AFTER_TOOL"); window.stepFrame();
  check(!!(tool.compareDocumentPosition(body("after-tool")) & Node.DOCUMENT_POSITION_FOLLOWING),
    "reply rendered before its tool");

  ready();
  delta("parked-code", "```javascript\nconst earlier = 1;\n```");
  delta("latest-part", "LATEST_PART"); window.stepFrame();
  emit({ type: "status", sessionId: "stream-test", status: "completedSuccess" });
  check(!!body("parked-code").querySelector("code span"), "completion skipped a parked code part");
  check(body("latest-part").dataset.copyText === "LATEST_PART", "finalizing an older part overwrote the latest one");

  const source = 'const greeting = "<script>window.__streamXss = true</script>";\n' +
    "function example(value) { return value + 1; }\n".repeat(180);
  for (const status of ["completedSuccess", "completedInterrupted"]) {
    ready();
    const text = "```javascript\n" + source;
    delta(status, text); window.stepFrame();
    const code = body(status).querySelector("code");
    // CommonMark removes the final fence-boundary newline, including at EOF.
    // Preserve the raw stream for later chunks; message copying trims edges.
    check(code.textContent === source.slice(0, -1), "streaming code was changed instead of escaped");
    check(body(status).dataset.streamText === text, "streaming dropped code source or its trailing newline");
    check(body(status).dataset.copyText === text.trim(), "streaming changed the copied code source");
    check(!code.querySelector("span"), "streaming known-language code was highlighted");
    delta(status, text + "// FINAL_TAIL\n```");
    emit({ type: "status", sessionId: "stream-test", status });
    check(body(status).dataset.copyText.endsWith("// FINAL_TAIL\n```"), status + " lost the same-frame tail");
    check(!!body(status).querySelector("code span"), status + " failed to add final highlighting");
    check(!body(status).querySelector("script"), "code became executable HTML after completion");
    check(!document.getElementById("send-btn").classList.contains("stop"), status + " retained generation state");
    const settledMarkdown = body(status).querySelector(".md");
    drainFrames();
    check(body(status).querySelector(".md") === settledMarkdown, "stale frame repainted a settled message");
  }

  ready();
  delta("explicit-final", "```\nconst value = 42;\n"); window.stepFrame();
  check(!body("explicit-final").querySelector("code span"), "streaming unknown-language code ran auto-detection");
  delta("explicit-final", "```\nconst pendingValue = 43;\n");
  delta("explicit-final", "```javascript\nconst finalValue = 42;\n```", { authoritative: true, streaming: false });
  check(!!body("explicit-final").querySelector("code span"), "explicit final part waited for a frame to highlight");
  check(body("explicit-final").dataset.copyText.includes("finalValue"), "explicit final did not replace pending text");
  drainFrames();
  check(!body("explicit-final").dataset.copyText.includes("pendingValue"), "a stale frame overwrote the explicit final part");

  ready();
  delta("old-reset", "DISCARD_BEFORE_RENDER");
  emit({ type: "view_reset", clear: true, viewGen: ++generation });
  drainFrames();
  check(!body("old-reset") && !messages.textContent.includes("DISCARD_BEFORE_RENDER"), "reset rendered an old pending bubble");
  emit({ type: "session_ready", sessionId: "next-session", viewGen: generation });
  emit({ type: "history", sessionId: "next-session", viewGen: generation,
    items: [{ id: "next-answer", role: "assistant", text: "NEW_SESSION_HISTORY" }] });
  drainFrames();
  check(messages.textContent.includes("NEW_SESSION_HISTORY") && !messages.textContent.includes("DISCARD_BEFORE_RENDER"),
    "pending old text leaked into another session's history");

  ready();
  delta("cleared", "DISCARD_WHEN_CLEARED"); emit({ type: "cleared" }); drainFrames();
  check(!messages.textContent.includes("DISCARD_WHEN_CLEARED"), "cleared chat revived a pending answer");

  ready();
  const unsafe = '<svg onload="window.__streamXss=true"></svg><a href="javascript:alert(1)">unsafe link</a>\n\n' +
    "```html\n<img src=x onerror=alert(1)>\n```\n\nMath $x^2$.";
  delta("unsafe", unsafe); window.stepFrame();
  check(!body("unsafe").querySelector("script,[onload],[onerror],[href^='javascript:']"), "streaming sanitizer allowed executable HTML");
  check(body("unsafe").querySelector("code").textContent === "<img src=x onerror=alert(1)>", "streamed HTML code was not preserved as text");
  check(!!body("unsafe").querySelector(".katex"), "streaming optimization disabled formula rendering");
  emit({ type: "status", sessionId: "stream-test", status: "completedSuccess" });
  check(!body("unsafe").querySelector("script,[onload],[onerror],[href^='javascript:']") && !window.__streamXss,
    "final highlighting bypassed HTML sanitization");

  for (const language of ["", "unsupported-language"]) {
    ready();
    const code = 'const tag = "<img src=x onerror=alert(1)>";';
    const source = "```" + language + "\n" + code + "\n```";
    delta("plain-code", source); window.stepFrame();
    emit({ type: "status", sessionId: "stream-test", status: "completedSuccess" });
    check(body("plain-code").querySelector("code").textContent === code && !body("plain-code").querySelector("code span,img"),
      "unknown-language completion changed or auto-highlighted code");
    emit({ type: "history", sessionId: "stream-test", viewGen: generation,
      items: [{ id: "plain-history", role: "assistant", text: source, tools: [] }] });
    const restored = messages.querySelector(".code-block");
    check(restored?.querySelector("code").textContent === code && !restored.querySelector("code span,img") && !!restored.querySelector("[data-copy]"),
      "unknown-language history lost escaping or its copy button");
  }

  ready("native-session");
  window.useNativeFrames();
  delta("native", "NATIVE"); delta("native", "NATIVE_LATEST");
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  check(body("native")?.dataset.copyText === "NATIVE_LATEST", "native requestAnimationFrame did not paint the latest text");
  emit({ type: "status", sessionId: "native-session", status: "completedSuccess" });
  check(window.errors.length === 0, "browser errors: " + window.errors.join(", "));
  return { checks };
}
