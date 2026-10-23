import assert from "node:assert/strict";
import test from "node:test";
import { KNOWN_WEBVIEW_MESSAGE_TYPES, parseWebviewMessage } from "./webviewMessages";

test("webview messages must be plain objects with a known type", () => {
  for (const raw of [null, undefined, "send", 42, [], [{ type: "send" }]]) {
    assert.deepEqual(parseWebviewMessage(raw), { ok: false, rejection: { reason: "not-object" } });
  }
  for (const raw of [{}, { type: 1 }, { type: "toString" }, { type: "__proto__" }, { type: "evalSomething" }]) {
    assert.deepEqual(parseWebviewMessage(raw), { ok: false, rejection: { reason: "unknown-type" } });
  }
  assert.ok(KNOWN_WEBVIEW_MESSAGE_TYPES.has("send"));
});

test("valid messages pass through and unknown fields are dropped", () => {
  const result = parseWebviewMessage({ type: "openFile", path: "src/a.ts", extra: "ignored", sessionId: "sess_1" });
  assert.deepEqual(result, { ok: true, message: { type: "openFile", path: "src/a.ts", sessionId: "sess_1" } });
});

test("fields with the wrong runtime kind reject the whole message", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ type: "send", sessionId: { id: "x" } }, "sessionId"],
    [{ type: "send", text: 123 }, "text"],
    [{ type: "editLast", rowId: "1" }, "rowId"],
    [{ type: "setChrome", enabled: "true" }, "enabled"],
    [{ type: "attachFileUris", sessionId: "s", uris: "file:///etc/passwd" }, "uris"],
    [{ type: "setChrome", chrome: [] }, "chrome"],
  ];
  for (const [raw, field] of cases) {
    assert.deepEqual(parseWebviewMessage(raw), { ok: false, rejection: { reason: "bad-field", field } });
  }
});

test("free-form settings and form answers are plain JSON within a size budget", () => {
  assert.equal(parseWebviewMessage({ type: "setChrome", chrome: { a: true, b: { c: "x" } } }).ok, true);
  assert.equal(parseWebviewMessage({ type: "setNewSessionDefaults", defaults: { modelId: "m", thoughtLevel: null } }).ok, true);
  for (const content of [null, "text", 3, [1, "a"], { answer: { choice: ["a", "b"] } }]) {
    assert.equal(parseWebviewMessage({ type: "userInputAnswer", content }).ok, true, JSON.stringify(content));
  }
  let deep: Record<string, unknown> = {};
  for (let i = 0; i < 20; i++) deep = { next: deep };
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ type: "setChrome", chrome: { big: "x".repeat(64 * 1024 + 1) } }, "chrome"],
    [{ type: "setChrome", chrome: { list: new Array(2000).fill(1) } }, "chrome"],
    [{ type: "setChrome", chrome: deep }, "chrome"],
    [{ type: "setChrome", chrome: { when: new Date(0) } }, "chrome"],
    [{ type: "setNewSessionDefaults", defaults: { n: Infinity } }, "defaults"],
    [{ type: "userInputAnswer", content: "x".repeat(1024 * 1024 + 1) }, "content"],
    [{ type: "userInputAnswer", content: deep }, "content"],
  ];
  for (const [raw, field] of cases) {
    assert.deepEqual(parseWebviewMessage(raw), { ok: false, rejection: { reason: "bad-field", field } }, field);
  }
});

test("JSON budgets are enforced before children are queued", () => {
  // Exactly at the budget passes; one more node fails (the root counts as one node).
  assert.equal(parseWebviewMessage({ type: "setChrome", chrome: { list: new Array(998).fill(0) } }).ok, true);
  assert.equal(parseWebviewMessage({ type: "setChrome", chrome: { list: new Array(999).fill(0) } }).ok, false);
  // A huge array is refused from its length: reading elements would throw.
  const trap = new Proxy(new Array(5_000_000), { get: (target, key) => {
    if (key === "length") return target.length;
    if (typeof key === "string" && /^\d+$/.test(key)) throw new Error(`element ${key} was read`);
    return Reflect.get(target, key);
  } });
  assert.equal(parseWebviewMessage({ type: "userInputAnswer", content: [trap] }).ok, false);
  // An object stops at the first property past the budget instead of walking all of them.
  let visited = 0;
  const wide: Record<string, unknown> = {};
  for (let i = 0; i < 50_000; i++) Object.defineProperty(wide, `k${i}`, { enumerable: true, get: () => { visited++; return 0; } });
  assert.equal(parseWebviewMessage({ type: "setChrome", chrome: wide }).ok, false);
  assert.ok(visited <= 1_000, `visited ${visited} properties`);
  // Depth is checked before queueing: exactly maxDepth passes, one more level fails.
  let atLimit: unknown = 0;
  for (let i = 0; i < 8; i++) atLimit = { n: atLimit };
  assert.equal(parseWebviewMessage({ type: "setChrome", chrome: atLimit }).ok, true);
  assert.equal(parseWebviewMessage({ type: "setChrome", chrome: { n: atLimit } }).ok, false);
});

test("paths must be non-empty, bounded and free of NUL bytes", () => {
  assert.equal(parseWebviewMessage({ type: "openFile", path: "a\0b" }).ok, false);
  assert.equal(parseWebviewMessage({ type: "openFile", path: "" }).ok, false);
  assert.equal(parseWebviewMessage({ type: "openFile", path: "x".repeat(4097) }).ok, false);
  assert.equal(parseWebviewMessage({ type: "openFile", path: "x".repeat(4096) }).ok, true);
});

test("string sizes are bounded", () => {
  assert.equal(parseWebviewMessage({ type: "send", sessionId: "s".repeat(64 * 1024 + 1) }).ok, false);
  assert.equal(parseWebviewMessage({ type: "send", text: "t".repeat(1024 * 1024) }).ok, true);
  assert.equal(parseWebviewMessage({ type: "uploadImage", dataUrl: "d".repeat(30 * 1024 * 1024) }).ok, false);
});

test("null optional fields are treated as absent except where null is meaningful", () => {
  assert.deepEqual(parseWebviewMessage({ type: "loadFileChanges", rowId: null, entityId: "e" }),
    { ok: true, message: { type: "loadFileChanges", entityId: "e" } });
  assert.deepEqual(parseWebviewMessage({ type: "queueReorder", queueItemId: "q", beforeQueueItemId: null }),
    { ok: true, message: { type: "queueReorder", queueItemId: "q", beforeQueueItemId: null } });
});

test("inherited properties are never read as message fields", () => {
  const proto = { sessionId: "sess_inherited" };
  const raw = Object.assign(Object.create(proto), { type: "send", text: "hi" });
  assert.deepEqual(parseWebviewMessage(raw), { ok: true, message: { type: "send", text: "hi" } });
});

test("numbers must be finite", () => {
  for (const rowId of [NaN, Infinity, -Infinity]) {
    assert.deepEqual(parseWebviewMessage({ type: "loadFileChanges", rowId, entityId: "e" }),
      { ok: false, rejection: { reason: "bad-field", field: "rowId" } });
  }
});

test("dropped file URIs must be bounded file: strings", () => {
  const ok = { type: "attachFileUris", sessionId: "s" };
  assert.equal(parseWebviewMessage({ ...ok, uris: ["file:///home/u/a.png", "FILE:///b.png"] }).ok, true);
  for (const uris of [["https://example.com/a.png"], ["vscode-remote://x/a"], [42], ["file:///" + "a".repeat(5000)], Array(1001).fill("file:///a")]) {
    assert.deepEqual(parseWebviewMessage({ ...ok, uris }), { ok: false, rejection: { reason: "bad-field", field: "uris" } });
  }
});

test("nested attachments, patches, file changes, chips and references are checked", () => {
  const patch = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] };
  assert.equal(parseWebviewMessage({ type: "openGitDiff", path: "a.ts", patches: [patch] }).ok, true);
  const bad: Array<[Record<string, unknown>, string]> = [
    [{ type: "send", attachments: ["ref"] }, "attachments"],
    [{ type: "send", attachments: Array(33).fill({}) }, "attachments"],
    [{ type: "send", attachments: [{ ref: 1 }] }, "attachments"],
    [{ type: "send", attachments: [{ ref: "a\0b" }] }, "attachments"],
    [{ type: "send", attachments: [{ ref: "r", fileName: "x".repeat(256) }] }, "attachments"],
    [{ type: "openGitDiff", path: "a.ts", patches: [{ ...patch, oldStart: "1" }] }, "patches"],
    [{ type: "openGitDiff", path: "a.ts", patches: [{ ...patch, lines: [1] }] }, "patches"],
    [{ type: "openGitDiff", path: "a.ts", patches: [{ ...patch, oldStart: NaN }] }, "patches"],
    [{ type: "openDiff", fileChange: { path: "a.ts", kind: "delete" } }, "fileChange"],
    [{ type: "openDiff", fileChange: { path: "a\0b", kind: "edit" } }, "fileChange"],
    [{ type: "send", chips: [{ relPath: "a" }] }, "chips"],
    [{ type: "send", sessionRefs: [{ sessionId: 1, title: "t" }] }, "sessionRefs"],
    [{ type: "loadPreviewFiles", previewCandidates: [{}] }, "previewCandidates"],
  ];
  for (const [raw, field] of bad) {
    assert.deepEqual(parseWebviewMessage(raw), { ok: false, rejection: { reason: "bad-field", field } });
  }
  assert.equal(parseWebviewMessage({ type: "openDiff", fileChange: { path: "a.ts", kind: "edit", before: "x", after: "y" } }).ok, true);
  assert.equal(parseWebviewMessage({ type: "send", chips: [{ path: "/w/a.ts", relPath: "a.ts", selectionStart: 1 }] }).ok, true);
});

test("sensitive message types require their essential fields", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ type: "openFile" }, "path"],
    [{ type: "openGitDiff", path: "a.ts" }, "patches"],
    [{ type: "openDiff" }, "fileChange"],
    [{ type: "openMarkdownFile", path: "a.md" }, "sessionId"],
    [{ type: "attachFileUris", sessionId: "s" }, "uris"],
    [{ type: "attachFileUris", uris: ["file:///a"] }, "sessionId"],
    [{ type: "uploadImage", sessionId: "s", imageId: "i" }, "dataUrl"],
    [{ type: "uploadImage", dataUrl: "data:image/png;base64,AA==", imageId: "i" }, "sessionId"],
  ];
  for (const [raw, field] of cases) {
    assert.deepEqual(parseWebviewMessage(raw), { ok: false, rejection: { reason: "missing-field", field } });
  }
});
