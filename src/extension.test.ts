import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import nodeOs from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import { mergeAvailablePickerModels, quotaProviderIsSelectable, ZCodeViewProvider } from "./extension";
import type { PickerModel, ResolvedRuntime } from "./desktop";
import { ZCodeClient } from "./zcodeClient";
import { StartupTiming } from "./startupTiming";
import type { AvailableModel } from "./zcodeClient";
import { setTestLanguage, setTestFiles, workspace, window as testWindow, recoveryCalls, recoveryNotices } from "./testSupport/vscode";

function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const fixtureDisposals = new Set<() => void>();
afterEach(() => {
  for (const dispose of fixtureDisposals) dispose();
  fixtureDisposals.clear();
});
function fixture() {
  const posted: Array<{ type: string; [key: string]: unknown }> = [];
  const visibility: boolean[] = [];
  let backgroundPolls = 0;
  const response = deferred();
  const provider = new ZCodeViewProvider({ extensionUri: "file:///unused", subscriptions: [], workspaceState: { get: () => undefined } } as unknown as vscode.ExtensionContext);
  const state = provider as unknown as {
    client: { currentSessionId: string; currentMode: () => string; confirmedModel: () => {providerId: string; modelId: string} | undefined; confirmedControls: () => Partial<import("./zcodeClient").SessionControls>; setViewVisible: (visible: boolean) => void; pollBackgroundRuns: () => void; dispose: () => void; editUserQuery: () => Promise<unknown>; insertQueuedMessage: (text?: unknown) => Promise<unknown>; conversationFileChanges: () => Promise<unknown>; sendMessage: (...args: unknown[]) => Promise<unknown>; setMode: (mode: string) => Promise<void>; setModel: (...args: unknown[]) => Promise<unknown>; hasFreshSessionModel: () => boolean; readAvailableModels: () => Promise<{ current?: { providerId: string; modelId: string }; available: AvailableModel[] }>;
      stageSessionModel: (model: { providerId: string; modelId: string } | null) => void;
      activitySince: () => number | undefined; noteHistoryDelivered: () => void; queuedMessages: () => unknown[] };
    switchTicket: number;
    webviewEpoch: number;
    pushedEpoch: number;
    post: (message: { type: string }) => void;
    indexCurrentSession: () => void;
    onWebviewMessage: (message: unknown) => Promise<void>;
    pushSessionState: (opts?: { forceHistory?: boolean }) => Promise<void>;
    startRunningPoll: () => void;
    postHistory: (page: { items: unknown[]; truncated: boolean }, viewGen?: number) => void;
    readSessionQuestions: (sessionId: string) => Array<{ id: string; text: string }>;
    picker: PickerModel[];
    disabledModelKeys: Set<string>;
    currentModel?: { providerId: string; modelId: string };
    pendingModel: { sessionId: string; providerId: string; modelId: string } | null;
    pushModels: () => Promise<void>;
    modelChoices: () => PickerModel[];
    resolveSessionModelRuntime: (model: { providerId: string; modelId: string }) => Promise<import("./desktop").ResolvedRuntime | null | false>;
  };
  let stagedSessionModel: { providerId: string; modelId: string } | null | undefined;
  const activeClient = { currentSessionId: "A", currentMode: () => "build", confirmedModel: () => state.currentModel, confirmedControls: () => ({mode:"build"}), setViewVisible: (visible: boolean) => { visibility.push(visible); }, pollBackgroundRuns: () => { backgroundPolls++; }, dispose: () => {}, editUserQuery: () => response.promise, insertQueuedMessage: () => response.promise, conversationFileChanges: () => response.promise, sendMessage: () => response.promise, setMode: async () => {}, setModel: async () => {}, hasFreshSessionModel: () => false, readAvailableModels: async () => ({ available: [] }), stageSessionModel: (model: { providerId: string; modelId: string } | null) => { stagedSessionModel = model; },
    activitySince: () => undefined, noteHistoryDelivered: () => {}, queuedMessages: () => [] };
  Object.assign(activeClient, {
    listSessionsPage: async (includeArchived = false) => ({
      sessions: await (state.client as unknown as { listSessions: (archived: boolean) => Promise<unknown[]> }).listSessions(includeArchived),
      hasMore: false,
    }),
  });
  state.client = activeClient;
  const pollState = provider as unknown as { runningPoll?: NodeJS.Timeout; dispose: () => void };
  state.post = message => posted.push(message);
  state.indexCurrentSession = () => {};
  let handler!: (message: unknown) => void;
  let onVisibilityChange = () => {};
  let onViewDispose = () => {};
  const releasedListeners: string[] = [];
  const view = {
    visible: true,
    onDidChangeVisibility: (callback: () => void) => { onVisibilityChange = callback; return { dispose() { releasedListeners.push("visibility"); } }; },
    onDidDispose: (callback: () => void) => { onViewDispose = callback; return { dispose() { releasedListeners.push("dispose"); } }; },
    webview: { cspSource: "file:", asWebviewUri: (uri: unknown) => uri, onDidReceiveMessage: (callback: typeof handler) => { handler = callback; return { dispose() { releasedListeners.push("message"); } }; } },
  };
  provider.resolveWebviewView(view as unknown as vscode.WebviewView);
  const dispose = () => {
    fixtureDisposals.delete(dispose);
    provider.dispose();
  };
  fixtureDisposals.add(dispose);
  const switchToB = () => {
    state.client.currentSessionId = "B";
    state.switchTicket++;
  };
  const setVisible = (visible: boolean) => { view.visible = visible; onVisibilityChange(); };
  const disposeView = () => onViewDispose();
  const stagedModels = () => stagedSessionModel;
  return { state, posted, response, handler, switchToB, setVisible, disposeView, releasedListeners, provider, view, visibility, pollState, backgroundPolls: () => backgroundPolls, stagedModels, dispose };
}

test("Markdown file links open workspace images and reject stale or escaping paths", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-markdown-link-"));
  try {
    const root = path.join(dir, "workspace");
    fs.mkdirSync(root);
    const image = path.join(root, "chart.png");
    const outside = path.join(dir, "outside.png");
    fs.writeFileSync(image, "image");
    fs.writeFileSync(outside, "outside");
    let linked = false;
    try { fs.symlinkSync(outside, path.join(root, "linked.png")); linked = true; }
    catch (e) { if (process.platform !== "win32") throw e; }
    const f = fixture();
    (f.state as typeof f.state & { workspacePath: string }).workspacePath = root;
    recoveryCalls.length = 0;
    recoveryNotices.length = 0;
    await f.state.onWebviewMessage({ type: "openMarkdownFile", path: image, sessionId: "A" });
    assert.equal(recoveryCalls.at(-1)?.command, "vscode.open");
    assert.equal((recoveryCalls.at(-1)?.args?.[0] as { fsPath: string }).fsPath, fs.realpathSync(image));
    assert.deepEqual(recoveryCalls.at(-1)?.args?.[1], { preview: true });
    await f.state.onWebviewMessage({ type: "openMarkdownFile", path: "chart.png", sessionId: "A" });
    assert.equal((recoveryCalls.at(-1)?.args?.[0] as { fsPath: string }).fsPath, fs.realpathSync(image));
    const opened = recoveryCalls.length;
    const rejected = [outside, path.join(root, "missing.png"), ...(linked ? [path.join(root, "linked.png")] : [])];
    for (const file of rejected) {
      await f.state.onWebviewMessage({ type: "openMarkdownFile", path: file, sessionId: "A" });
    }
    await f.state.onWebviewMessage({ type: "openMarkdownFile", path: image, sessionId: "B" });
    assert.equal(recoveryCalls.length, opened, "an unsafe or stale link reached vscode.open");
    assert.equal(recoveryNotices.length, rejected.length, "rejected local links gave no actionable feedback");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("generated-file preview uses this turn's changed paths and ignores a late session result", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-preview-host-"));
  try {
    const file = path.join(root, "test-hello.md");
    fs.writeFileSync(file, "test");
    const f = fixture();
    (f.state as typeof f.state & { workspacePath: string }).workspacePath = root;
    f.state.client.conversationFileChanges = async () => [{ path: "test-hello.md", additions: 1, deletions: 0, patches: [] }];
    const request = { type: "loadPreviewFiles", sessionId: "A", turnId: "turn-1", signature: "v1",
      previewCandidates: [file], rowId: 12, entityId: "header-1", fileChangesState: "active" };
    await f.state.onWebviewMessage(request);
    assert.deepEqual(f.posted.find(message => message.type === "preview_files")?.cards,
      [{ path: "test-hello.md", name: "test-hello.md", kind: "markdown", extension: "MD" }]);
    f.posted.length = 0;
    await f.state.onWebviewMessage({ ...request, signature: "reverted", fileChangesState: "reverted" });
    assert.deepEqual(f.posted.find(message => message.type === "preview_files")?.cards, []);
    f.posted.length = 0;
    let finish!: (files: never[]) => void;
    f.state.client.conversationFileChanges = () => new Promise(resolve => { finish = resolve; });
    const pending = f.state.onWebviewMessage({ ...request, signature: "late" });
    f.switchToB();
    finish([{ path: "test-hello.md", additions: 1, deletions: 0, patches: [] }] as never[]);
    await pending;
    assert.equal(f.posted.some(message => message.type === "preview_files"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("model picker includes enabled backend shortcuts, excludes desktop-disabled models, and stays session-scoped", async () => {
  const f = fixture();
  f.state.disabledModelKeys = new Set(["moonshot-kimi\0k3"]);
  const deepseek: AvailableModel = {
    providerId: "deepseek",
    modelId: "deepseek-flash",
    label: "deepseek-flash",
    providerLabel: "DeepSeek",
  };
  f.state.picker = [{
    providerId: "configured-provider",
    providerName: "Configured provider",
    kind: "openai-compatible",
    modelId: "configured-model",
    label: "configured-model",
    hasKey: true,
  }];
  f.state.currentModel = { providerId: "account:team", modelId: "current-model" };
  f.state.client.hasFreshSessionModel = () => true;
  let finishA!: (value: { available: AvailableModel[] }) => void;
  f.state.client.readAvailableModels = () => new Promise(resolve => { finishA = resolve; });

  const staleRead = f.state.pushModels();
  f.switchToB();
  finishA({ available: [deepseek] });
  await staleRead;
  assert.deepEqual(f.state.modelChoices().map(model => model.providerId), ["configured-provider"],
    "a delayed catalog from session A leaked into session B");

  f.state.client.readAvailableModels = async () => ({ available: [{
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    label: "deepseek-v4-pro",
    providerLabel: "DeepSeek",
  }, {
    providerId: "moonshot-kimi",
    modelId: "k3",
    label: "k3",
    providerLabel: "Kimi",
  }] });
  await f.state.pushModels();
  const posted = f.posted.filter(message => message.type === "models").at(-1);
  const available = posted?.available as PickerModel[];
  assert.deepEqual(available.map(model => [model.providerId, model.modelId]), [
    ["configured-provider", "configured-model"],
    ["deepseek", "deepseek-v4-pro"],
  ], "a desktop-disabled model must not be re-added from the live backend catalog");
  assert.equal(available[1].providerName, "DeepSeek");
  assert.equal(available[1].hasKey, true);
});

test("desktop-managed shortcut and OAuth providers reject stale live catalog models", () => {
  const current: PickerModel = {
    providerId: "sampleVendor",
    providerName: "sampleVendor",
    kind: "unknown",
    modelId: "qwen3.8-max",
    label: "qwen3.8-max",
    hasKey: true,
  };
  const officialOAuthModel: PickerModel = {
    providerId: "account:bigmodel-team-coding-plan",
    providerName: "BigModel Team",
    kind: "anthropic",
    modelId: "GLM-5.3",
    label: "GLM-5.3",
    hasKey: true,
  };
  const available: AvailableModel[] = [
    { providerId: "sampleVendor", modelId: "qwen3.8-max", label: "qwen3.8-max" },
    { providerId: "sampleVendor", modelId: "glm-5.2", label: "glm-5.2" },
    { providerId: "sampleVendor", modelId: "removed-from-shortcuts", label: "removed-from-shortcuts" },
    { providerId: "account:bigmodel-team-coding-plan", modelId: "GLM-5.3", label: "GLM-5.3" },
    { providerId: "account:bigmodel-team-coding-plan", modelId: "removed-official-model", label: "removed-official-model" },
    { providerId: "other-provider", modelId: "live-model", label: "live-model" },
  ];
  const merged = mergeAvailablePickerModels(
    [current, officialOAuthModel],
    available,
    new Set(),
    new Set(["sampleVendor", "account:bigmodel-team-coding-plan"])
  );
  assert.deepEqual(merged.map(model => [model.providerId, model.modelId]), [
    ["sampleVendor", "qwen3.8-max"],
    ["account:bigmodel-team-coding-plan", "GLM-5.3"],
    ["other-provider", "live-model"],
  ], "keep configured official OAuth models but reject stale models from both managed catalogs");
});

test("authoritative desktop provider inventory rejects deleted providers from the live catalog", () => {
  const current: PickerModel = {
    providerId: "active-provider",
    providerName: "Active provider",
    kind: "openai-compatible",
    modelId: "active-model",
    label: "active-model",
    hasKey: true,
  };
  const account: PickerModel = {
    providerId: "account:bigmodel-team-coding-plan",
    providerName: "BigModel Team",
    kind: "anthropic",
    modelId: "GLM-5.3",
    label: "GLM-5.3",
    hasKey: true,
  };
  const merged = mergeAvailablePickerModels(
    [current, account],
    [
      { providerId: "active-provider", modelId: "active-model", label: "active-model" },
      { providerId: "deleted-sample-provider", modelId: "sample-model", label: "sample-model" },
      { providerId: "newly-cached-provider", modelId: "stale-model", label: "stale-model" },
      { providerId: "account:bigmodel-team-coding-plan", modelId: "GLM-5.3", label: "GLM-5.3" },
    ],
    new Set(),
    new Set(["active-provider"]),
    true
  );
  assert.deepEqual(merged.map(model => [model.providerId, model.modelId]), [
    ["active-provider", "active-model"],
    ["account:bigmodel-team-coding-plan", "GLM-5.3"],
  ]);
});

test("model changes before the first question stay silent even if history echoes before send admission", async () => {
  const f = fixture();
  const state = f.state as typeof f.state & {
    noteSwitchBanner: (from: { providerId: string; modelId: string }, to: { providerId: string; modelId: string }) => void;
  };
  const first = { providerId: "provider", modelId: "first" };
  const second = { providerId: "provider", modelId: "second" };
  state.noteSwitchBanner(first, second);
  const sending = state.onWebviewMessage({ type: "send", sessionId: "A", commandId: "first-send", text: "first question" });
  state.postHistory({ items: [{ id: "first-user", role: "user", text: "first question" }], truncated: false });
  f.response.resolve();
  await sending;
  assert.equal(f.posted.filter(message => message.type === "model_switched").length, 0);
  assert.equal(f.posted.filter(message => message.type === "send_admitted").length, 1);

  state.noteSwitchBanner(second, first);
  await state.onWebviewMessage({ type: "send", sessionId: "A", commandId: "second-send", text: "second question" });
  const marks = f.posted.filter(message => message.type === "model_switched");
  assert.equal(marks.length, 1);
  assert.equal(marks[0].sessionId, "A");
  assert.equal((marks[0].to as { modelId: string }).modelId, "first");
  f.dispose();
});

test("a model-switch notice stays with its session while another conversation sends", async () => {
  const f = fixture();
  const state = f.state as typeof f.state & {
    noteSwitchBanner: (from: { providerId: string; modelId: string }, to: { providerId: string; modelId: string }) => void;
  };
  state.postHistory({ items: [{ id: "A-user", role: "user", text: "earlier A question" }], truncated: false });
  state.noteSwitchBanner({ providerId: "provider", modelId: "A-old" }, { providerId: "provider", modelId: "A-new" });
  f.switchToB();
  state.postHistory({ items: [{ id: "B-user", role: "user", text: "earlier B question" }], truncated: false });
  f.response.resolve();
  await state.onWebviewMessage({ type: "send", sessionId: "B", commandId: "B-send", text: "new B question" });
  assert.equal(f.posted.filter(message => message.type === "model_switched").length, 0,
    "B displayed A's pending model change");

  state.client.currentSessionId = "A";
  state.switchTicket++;
  await state.onWebviewMessage({ type: "send", sessionId: "A", commandId: "A-send", text: "new A question" });
  const marks = f.posted.filter(message => message.type === "model_switched");
  assert.equal(marks.length, 1);
  assert.equal(marks[0].sessionId, "A");
  assert.equal((marks[0].to as { modelId: string }).modelId, "A-new");
  f.dispose();
});

test("model changes in a truncated restored conversation retain their notice when the loaded tail has no question", async () => {
  const f = fixture();
  const state = f.state as typeof f.state & {
    noteSwitchBanner: (from: { providerId: string; modelId: string }, to: { providerId: string; modelId: string }) => void;
  };
  state.readSessionQuestions = () => [{ id: "older-user", text: "an earlier question outside the loaded page" }];
  state.postHistory({ items: [{ id: "tail-answer", role: "assistant", text: "last part of a long reply" }], truncated: true });
  state.noteSwitchBanner({ providerId: "provider", modelId: "old" }, { providerId: "provider", modelId: "new" });
  f.response.resolve();
  await state.onWebviewMessage({ type: "send", sessionId: "A", commandId: "restored-send", text: "follow-up question" });
  const marks = f.posted.filter(message => message.type === "model_switched");
  assert.equal(marks.length, 1);
  assert.equal(marks[0].sessionId, "A");
  assert.equal((marks[0].from as { modelId: string }).modelId, "old");
  assert.equal((marks[0].to as { modelId: string }).modelId, "new");
  f.dispose();
});

test("panel visibility pauses background SQLite polling and immediately catches up when shown", () => {
  const f = fixture();
  f.state.startRunningPoll();
  assert.equal(f.backgroundPolls(), 1, "visible panel did not perform initial status catch-up");
  assert.ok(f.pollState.runningPoll, "visible panel did not start the poll timer");
  f.setVisible(false);
  assert.equal(f.pollState.runningPoll, undefined, "hidden panel kept the background poll timer");
  assert.equal(f.backgroundPolls(), 1, "hidden panel performed an unnecessary poll");
  f.setVisible(true);
  assert.ok(f.pollState.runningPoll, "visible panel did not resume the poll timer");
  assert.equal(f.backgroundPolls(), 2, "showing the panel did not immediately refresh background status");
  assert.deepEqual(f.visibility, [true, false, true]);
  f.setVisible(false);
  f.dispose();
});

test("a disposed webview view is dropped and its listeners are released", () => {
  const f = fixture();
  const viewState = f.provider as unknown as { view?: unknown };
  f.state.startRunningPoll();
  assert.ok(f.pollState.runningPoll);
  f.disposeView();
  assert.equal(viewState.view, undefined, "disposed view was kept");
  assert.equal(f.pollState.runningPoll, undefined, "disposed view kept the background poll timer");
  assert.deepEqual([...f.releasedListeners].sort(), ["dispose", "message", "visibility"]);
  assert.equal(f.visibility.at(-1), false);
  f.setVisible(true);
  assert.equal(f.pollState.runningPoll, undefined, "a stale visibility event revived the poll");
  f.dispose();
});

test("resolving a new view releases the previous view's listeners first", () => {
  const f = fixture();
  f.provider.resolveWebviewView(f.view as unknown as vscode.WebviewView);
  assert.deepEqual([...f.releasedListeners].sort(), ["dispose", "message", "visibility"]);
  f.dispose();
});

test("every page load receives the session state, even without a new resolveWebviewView", async () => {
  const f = fixture();
  const pushes: Array<{ forceHistory?: boolean } | undefined> = [];
  const refreshed: string[] = [];
  Object.assign(f.state.client, { refreshSkillCatalog: () => refreshed.push("skills"), refreshSubagentCatalog: () => refreshed.push("agents") });
  f.state.pushSessionState = async opts => { pushes.push(opts); f.state.pushedEpoch = f.state.webviewEpoch; };
  await f.state.onWebviewMessage({ type: "ready" });
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0]?.forceHistory, true);
  // Reload Webviews / renderer recovery: the same view posts "ready" again from a blank page.
  await f.state.onWebviewMessage({ type: "ready" });
  assert.equal(pushes.length, 2, "a reloaded page stayed blank");
  assert.deepEqual(refreshed, ["skills", "agents", "skills", "agents"]);
  f.dispose();
});

test("webview session actions acknowledge only after their operation settles", async () => {
  const f = fixture();
  const state = f.state as typeof f.state & {
    archiveSession: (id: string, archived: boolean) => Promise<void>;
    deleteSession: (id: string) => Promise<void>;
  };
  const gate = deferred();
  state.archiveSession = async (id, archived) => {
    assert.deepEqual([id, archived], ["A", true]);
    await gate.promise;
  };
  const archiving = f.state.onWebviewMessage({ type: "archiveSession", sessionId: "A", actionRequestId: "archive-1" });
  assert.deepEqual(f.posted, [], "archive acknowledged before its operation completed");
  gate.resolve();
  await archiving;
  assert.deepEqual(f.posted, [{ type: "session_action_complete", sessionId: "A", actionRequestId: "archive-1" }]);

  f.posted.length = 0;
  state.deleteSession = async () => { throw new Error("delete failed"); };
  await assert.rejects(f.state.onWebviewMessage({ type: "deleteSession", sessionId: "A", actionRequestId: "delete-2" }), /delete failed/);
  assert.deepEqual(f.posted, [{ type: "session_action_complete", sessionId: "A", actionRequestId: "delete-2" }], "failed operation left the UI pending");
  f.dispose();
});

test("question index is re-read from the database only when delivered user rows change", () => {
  const f = fixture();
  let reads = 0;
  f.state.readSessionQuestions = () => { reads++; return [{ id: "q1", text: "FIRST" }, { id: "q2", text: "SECOND" }]; };
  const items = [{ id: "q1", role: "user", text: "FIRST" }, { id: "a1", role: "assistant", text: "ANSWER" }];
  f.state.postHistory({ items, truncated: false }, 1);
  f.state.postHistory({ items: [...items, { id: "a2", role: "assistant", text: "MORE" }], truncated: false }, 1);
  assert.equal(reads, 1, "assistant-only changes re-scanned the database");
  f.state.postHistory({ items: [...items, { id: "q2", role: "user", text: "SECOND" }], truncated: false }, 1);
  assert.equal(reads, 2, "a new question did not refresh the index");
  f.state.postHistory({ items: [...items, { id: "q2", role: "user", text: "SECOND (edited)" }], truncated: false }, 1);
  assert.equal(reads, 3, "an edited question did not refresh the index");
  // A row that the database has not persisted yet must not pin a stale index.
  f.state.postHistory({ items: [...items, { id: "q3", role: "user", text: "THIRD" }], truncated: false }, 1);
  f.state.postHistory({ items: [...items, { id: "q3", role: "user", text: "THIRD" }], truncated: false }, 1);
  assert.equal(reads, 5, "an unpersisted question was cached");
  const indexes = f.posted.filter(message => message.type === "question_index");
  assert.equal(indexes.length, 6);
  assert.deepEqual(indexes[1].questions, [{ id: "q1", text: "FIRST" }, { id: "q2", text: "SECOND" }]);
  assert.equal(indexes[1].sessionId, "A");
  f.dispose();
});

test("session refresh distinguishes a failed first load from a stale list", async () => {
  const f = fixture();
  const state = f.state as unknown as {
    client: { currentSessionId?: string; listSessions: (includeArchived?: boolean) => Promise<unknown[]> };
    sessionListViews: Record<"active" | "archived", {
      sessions: Array<{ sessionId: string; title: string; archivedAt?: number }>;
      state: "unknown" | "ready" | "failed";
      loaded: boolean;
    }>;
    refreshSessions: (includeArchived?: boolean, startupList?: unknown, listVisible?: boolean) => Promise<void>;
  };
  const ids = (message: { [key: string]: unknown } | undefined) => {
    const sessions = message?.sessions;
    return Array.isArray(sessions)
      ? sessions.map(session => String((session as { sessionId?: string }).sessionId))
      : [];
  };
  state.client.listSessions = async () => { throw new Error("list unavailable"); };
  await state.refreshSessions(false, undefined, true);
  assert.equal(f.posted.at(-1)?.notice, "initial");
  assert.deepEqual(f.posted.at(-1)?.sessions, []);

  const active = { sessionId: "A", title: "Active chat" };
  const archived = { sessionId: "C", title: "Archived chat", archivedAt: 5 };
  state.sessionListViews.active = { sessions: [active], state: "ready", loaded: true };
  state.sessionListViews.archived = { sessions: [archived], state: "ready", loaded: true };
  const before = f.posted.length;
  await state.refreshSessions(true);
  assert.equal(f.posted.length, before, "hidden stale failure replaced the displayed list");
  await state.refreshSessions(true, undefined, true);
  assert.equal(f.posted.at(-1)?.notice, "stale");
  assert.equal(f.posted.at(-1)?.includeArchived, true);
  assert.deepEqual(ids(f.posted.at(-1)), ["C"]);
  await state.refreshSessions(false, undefined, true);
  assert.equal(f.posted.at(-1)?.notice, "stale");
  assert.equal(f.posted.at(-1)?.includeArchived, false);
  assert.deepEqual(ids(f.posted.at(-1)), ["A"]);

  const archivedOnly = fixture();
  const archivedState = archivedOnly.state as unknown as typeof state;
  archivedState.client.listSessions = async () => { throw new Error("list unavailable"); };
  archivedState.sessionListViews.archived = { sessions: [archived], state: "ready", loaded: true };
  await archivedState.refreshSessions(false, undefined, true);
  assert.equal(archivedOnly.posted.at(-1)?.notice, "initial");
  assert.equal(archivedOnly.posted.at(-1)?.includeArchived, false);
  assert.deepEqual(archivedOnly.posted.at(-1)?.sessions, []);
  const activeOnly = fixture();
  const activeState = activeOnly.state as unknown as typeof state;
  activeState.client.listSessions = async () => { throw new Error("list unavailable"); };
  activeState.sessionListViews.active = { sessions: [active], state: "ready", loaded: true };
  await activeState.refreshSessions(true, undefined, true);
  assert.equal(activeOnly.posted.at(-1)?.notice, "initial");
  assert.equal(activeOnly.posted.at(-1)?.includeArchived, true);
  assert.deepEqual(activeOnly.posted.at(-1)?.sessions, []);

  let releaseFresh!: () => void;
  const fresh = new Promise<void>(resolve => { releaseFresh = resolve; });
  state.client.listSessions = async () => { await fresh; return [{ sessionId: "B", title: "Fresh chat" }]; };
  const refreshing = state.refreshSessions(false, undefined, true);
  state.client.listSessions = async () => { throw new Error("newer failure"); };
  await state.refreshSessions(false, undefined, true);
  releaseFresh();
  await refreshing;
  assert.equal(f.posted.at(-1)?.notice, "stale");
  assert.deepEqual(ids(f.posted.at(-1)), ["A"]);

  const moved = fixture();
  const movedState = moved.state as unknown as typeof state & { adoptWorkspace: (workspacePath: string) => void };
  let workspace = "/work/a";
  movedState.client.listSessions = async () => workspace === "/work/a"
    ? [{ sessionId: "A", title: "Directory A" }]
    : Promise.reject(new Error("directory B unavailable"));
  movedState.adoptWorkspace("/work/a");
  await movedState.refreshSessions(false, undefined, true);
  movedState.adoptWorkspace("/work/b");
  workspace = "/work/b";
  await movedState.refreshSessions(false, undefined, true);
  assert.equal(moved.posted.at(-1)?.notice, "initial");
  assert.equal(moved.posted.at(-1)?.currentId, "A");
  assert.deepEqual(moved.posted.at(-1)?.sessions, []);
  await movedState.refreshSessions(true, undefined, true);
  assert.equal(moved.posted.at(-1)?.notice, "initial");
  assert.deepEqual(moved.posted.at(-1)?.sessions, []);
  archivedOnly.dispose();
  activeOnly.dispose();
  moved.dispose();
});

test("startup status names the phase and reports a long wait without technical details", () => {
  const f = fixture();
  const state = f.state as unknown as {
    startupPhase: "starting" | "restoring" | null;
    startupPhaseSince: number;
    postStartupPhase: () => void;
    clearStartupPhase: () => void;
  };
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    state.startupPhase = "restoring";
    state.startupPhaseSince = now;
    state.postStartupPhase();
    assert.deepEqual(f.posted.at(-1), { type: "status", status: "connecting", phase: "restoring" });
    now += 8_000;
    state.postStartupPhase();
    assert.deepEqual(f.posted.at(-1), { type: "status", status: "connecting", phase: "restoring", waitedSeconds: 8 });
    state.clearStartupPhase();
    assert.equal(state.startupPhase, null);
  } finally {
    Date.now = originalNow;
  }
});

test("fixtures remain active across event-loop turns until the test releases them", async () => {
  const f = fixture();
  const client = f.state.client;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.client, client);
  assert.deepEqual(f.releasedListeners, []);
  f.switchToB();
  assert.equal(client.currentSessionId, "B");
  f.dispose();
  assert.equal(f.state.client, null);
  assert.deepEqual(f.releasedListeners.sort(), ["dispose", "message", "visibility"]);
});

const startupRuntime: ResolvedRuntime = {
  providerId: "configured-provider", providerName: "Configured", kind: "openai-compatible",
  baseURL: "https://example.test/v1", apiKey: "TEST-ONLY-KEY", modelId: "configured-model",
  models: {}, source: "custom-provider",
};

test("startup config write failures stop the notice and report the filesystem error", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-startup-config-"));
  t.mock.method(nodeOs, "homedir", () => home);
  fs.mkdirSync(path.join(home, ".zcode"));
  fs.writeFileSync(path.join(home, ".zcode", "cli"), "not-a-directory");
  const f = fixture();
  const state = f.state as unknown as {
    beginStartupPhase: (phase: "starting") => void;
    startupPhase: string | null;
    startupPhaseTimer?: NodeJS.Timeout;
    syncStartupConfig: (runtime: ResolvedRuntime, timing: StartupTiming) => void;
    failStartupPreparation: (error: unknown) => void;
  };
  const timing = new StartupTiming("open");
  try {
    state.beginStartupPhase("starting");
    assert.ok(state.startupPhaseTimer);
    const notices = recoveryNotices.length;
    assert.throws(() => state.syncStartupConfig(startupRuntime, timing), error => {
      assert.equal((error as NodeJS.ErrnoException).code, "EEXIST");
      state.failStartupPreparation(error);
      return true;
    });
    assert.equal(state.startupPhase, null);
    assert.equal(state.startupPhaseTimer, undefined);
    assert.equal(recoveryNotices.length, notices + 1);
    assert.ok(f.posted.some(message => message.type === "session_error" && /EEXIST/.test(String(message.message))));
  } finally {
    timing.dispose();
    f.dispose();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

for (const lateResult of ["success", "failure"] as const) {
  test(`parallel config failure returns before backend startup and ignores late ${lateResult}`, async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-startup-pending-"));
    t.mock.method(nodeOs, "homedir", () => home);
    fs.mkdirSync(path.join(home, ".zcode"));
    fs.writeFileSync(path.join(home, ".zcode", "cli"), "not-a-directory");
    const pendingStart = deferred();
    let actualClient: ZCodeClient | undefined;
    const start = t.mock.method(ZCodeClient.prototype, "start", function (this: ZCodeClient) {
      actualClient = this;
      return pendingStart.promise.then(() => undefined);
    });
    const originalDispose = ZCodeClient.prototype.dispose;
    const dispose = t.mock.method(ZCodeClient.prototype, "dispose", function (this: ZCodeClient) {
      originalDispose.call(this);
    });
    const f = fixture();
    const state = f.state as unknown as {
      context: { globalStorageUri: { fsPath: string } };
      client: ZCodeClient | null;
      startupPhase: string | null;
      startupPhaseTimer?: NodeJS.Timeout;
      startWhileLoginRuns: (timing: StartupTiming, started: number, login: Promise<unknown>, launch: unknown) => Promise<void>;
    };
    state.context = { globalStorageUri: { fsPath: path.join(home, "storage") } };
    const timing = new StartupTiming("open");
    try {
      const notices = recoveryNotices.length;
      const startup = state.startWhileLoginRuns(timing, Date.now(),
        Promise.resolve({ ok: true, runtime: startupRuntime, picker: [] }), {
          binaryPath: path.join(home, "unused-binary"), nodePath: "", workspacePath: home,
        });
      // Give all immediate continuations a turn; the backend promise stays pending.
      let finished = false;
      void startup.then(() => { finished = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(start.mock.callCount(), 1);
      assert.ok(actualClient);
      assert.equal(finished, true, "configuration failure waited for backend startup");
      await startup;
      assert.equal(state.client, null);
      assert.equal(dispose.mock.callCount(), 1);
      assert.equal(dispose.mock.calls[0].this, actualClient);
      assert.equal(state.startupPhase, null);
      assert.equal(state.startupPhaseTimer, undefined);
      assert.equal(f.pollState.runningPoll, undefined);
      assert.equal(recoveryNotices.length, notices + 1);
      assert.ok(f.posted.some(message => message.type === "session_error" && /EEXIST/.test(String(message.message))));
      const beforeLateResult = f.posted.length;
      if (lateResult === "success") pendingStart.resolve();
      else pendingStart.reject(new Error("late backend startup failure"));
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(f.posted.slice(beforeLateResult), []);
      assert.equal(dispose.mock.callCount(), 1);
    } finally {
      pendingStart.resolve();
      timing.dispose();
      f.dispose();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

test("late accepted edit cannot rewind a different session's transcript", async () => {
  const f = fixture();
  const edit = f.state.onWebviewMessage({ type: "editLast", sessionId: "A", viewGen: f.state.switchTicket, editRequestId: "attempt-A", commandId: "edit-command-A", rowId: 1, entityId: "user-A", text: "edit-A" });
  f.switchToB(); f.response.resolve(); await edit;
  assert.deepEqual(f.posted, []);
  f.dispose();
});

test("editing a question preserves validated conversation references in the backend rewrite", async () => {
  const f = fixture();
  const sessionId = "sess_11111111-1111-4111-8111-111111111111";
  let rewrittenText = "";
  const state = f.state as unknown as {
    sessionListViews: { active: { sessions: Array<{ sessionId: string; title: string; archivedAt?: number }>; state: string; loaded: boolean } };
    client: { currentSessionId: string; editUserQuery: (target: unknown, text: string, mode: string, attachments?: unknown) => Promise<unknown> };
    onWebviewMessage: (message: unknown) => Promise<void>;
  };
  state.sessionListViews.active = { sessions: [{ sessionId, title: "Referenced conversation" }], state: "ready", loaded: true };
  state.client.editUserQuery = async (_target, text) => { rewrittenText = text; };

  await state.onWebviewMessage({
    type: "editLast",
    viewGen: f.state.switchTicket, editRequestId: "attempt-A", commandId: "edit-command-A",
    sessionId: "A",
    rowId: 1,
    entityId: "user-A",
    text: "Explain this conversation",
    sessionRefs: [{ sessionId, title: "stale title from the webview" }],
  });

  assert.equal(rewrittenText, "[#Referenced conversation](#sess_11111111-1111-4111-8111-111111111111)\n\nExplain this conversation");
  assert.deepEqual(f.posted, [{ type: "query_rewound", text: rewrittenText, sessionId: "A", viewGen: f.state.switchTicket, editRequestId: "attempt-A", commandId: "edit-command-A", entityId: "user-A", attachments: [] }]);
  f.dispose();
});

test("conversation references remain available across active and archived list pages", async () => {
  const f = fixture();
  const active = { sessionId: "sess_reference", title: "Referenced conversation" };
  const archived = { sessionId: "sess_archived", title: "Archived conversation", archivedAt: 1 };
  let listed: Array<{ sessionId: string; title: string; archivedAt?: number }> = [active, archived];
  const state = f.state as unknown as {
    client: { listSessions: () => Promise<typeof listed> };
    refreshSessions: (includeArchived?: boolean, startupList?: unknown, listVisible?: boolean) => Promise<void>;
    sessionReferences: (references: Array<{ sessionId: string; title: string }>) => typeof listed;
    adoptWorkspace: (workspacePath: string) => void;
    applyRename: (sessionId: string, title: string) => Promise<void>;
  };
  state.client.listSessions = async () => listed;
  await state.refreshSessions(false);
  assert.deepEqual(state.sessionReferences([active]), [active]);
  await state.refreshSessions(true);
  assert.deepEqual(state.sessionReferences([active]), [active], "viewing archives invalidated an active reference");
  assert.deepEqual((f.posted.at(-1)?.sessions as typeof listed).map(session => session.sessionId), [archived.sessionId]);
  assert.deepEqual(f.posted.at(-1)?.referenceSessions, [active]);
  assert.throws(() => state.sessionReferences([archived]), /不可用/);

  listed = [{ ...active, archivedAt: 5 }, archived];
  await state.refreshSessions(true);
  assert.throws(() => state.sessionReferences([active]), /不可用/, "archived references must be rejected");
  listed = [active, archived];
  await state.refreshSessions(true);
  assert.deepEqual(state.sessionReferences([active]), [active], "restored references were not refreshed from the archive page");

  state.client.listSessions = async () => { throw new Error("offline"); };
  await state.refreshSessions(true, undefined, true);
  assert.deepEqual(f.posted.at(-1)?.referenceSessions, [active]);
  assert.deepEqual(state.sessionReferences([active]), [active], "a transient list failure discarded the active catalog");
  await state.applyRename(active.sessionId, "Renamed reference");
  assert.deepEqual(state.sessionReferences([active]), [{ ...active, title: "Renamed reference" }], "a failed list refresh discarded the successfully renamed title");
  state.adoptWorkspace("/work/a");
  state.adoptWorkspace("/work/b");
  assert.deepEqual(f.posted.at(-1)?.referenceSessions, []);
  const resetMessages = f.posted.length;
  await state.refreshSessions(false);
  assert.equal(f.posted.length, resetMessages, "a hidden failed refresh must not be needed to clear workspace references");
  assert.throws(() => state.sessionReferences([active]), /不可用/, "references leaked across workspace boundaries");
  f.dispose();
});

test("late rejected queue insert cannot mark another session as failed", async () => {
  const f = fixture();
  f.handler({ type: "insert", sessionId: "A", text: "insert-A", queueItemId: "command-A" });
  f.switchToB(); f.response.reject(new Error("failed in A"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.posted, [{ type: "queue_rejected", commandId: "command-A", sessionId: "A", text: "insert-A", chips: [], message: "failed in A" }]);
  assert.ok(!f.posted.some(message => message.type === "session_error"));
  f.dispose();
});

test("late accepted queue insert is acknowledged to its source session without recovery", async () => {
  const f = fixture();
  f.handler({ type: "insert", sessionId: "A", text: "insert-A", queueItemId: "command-A" });
  f.switchToB();
  f.response.resolve("command-A");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.posted, [{ type: "queue_admitted", commandId: "command-A", sessionId: "A" }]);
  f.dispose();
});

test("queued /plan switches its owning session before inserting the task body", async () => {
  const f = fixture();
  const order: string[] = [];
  f.state.client.setMode = async mode => { order.push(`mode:${mode}`); };
  f.state.client.insertQueuedMessage = async (text: unknown) => { order.push(`insert:${String(text)}`); return "plan-queue-A"; };
  f.handler({
    type: "insert", sessionId: "A", queueItemId: "plan-queue-A", text: "Explain the change",
    planMode: true, recoveryText: "/plan Explain the change",
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ["mode:plan", "insert:Explain the change"]);
  assert.deepEqual(f.posted, [{ type: "queue_admitted", commandId: "plan-queue-A", sessionId: "A" }]);
  f.dispose();
});

test("queued /plan mode failure restores controls and its original command draft", async () => {
  const f = fixture();
  let inserts = 0;
  f.state.client.setMode = async () => { throw new Error("mode unavailable"); };
  f.state.client.insertQueuedMessage = async () => { inserts++; return "plan-queue-A"; };
  f.handler({
    type: "insert", sessionId: "A", queueItemId: "plan-queue-A", text: "Explain the change",
    planMode: true, recoveryText: "/plan Explain the change",
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inserts, 0);
  assert.deepEqual(f.posted[0], { type: "session_controls", mode: "build" });
  assert.equal(f.posted[1].type, "queue_rejected");
  assert.equal(f.posted[1].text, "/plan Explain the change");
  f.dispose();
});

test("queue mutations require their exact owning session", async () => {
  const f = fixture();
  const calls: string[] = [];
  const client = f.state.client as typeof f.state.client & {
    editQueuedMessage: () => Promise<void>; deleteQueuedMessage: () => Promise<void>;
  };
  client.editQueuedMessage = async () => { calls.push("edit"); };
  client.deleteQueuedMessage = async () => { calls.push("delete"); };
  f.handler({ type: "queueEdit", sessionId: "A", queueItemId: "q-A", text: "updated" });
  f.handler({ type: "queueDelete", sessionId: "A", queueItemId: "q-A" });
  f.switchToB();
  f.handler({ type: "queueEdit", sessionId: "A", queueItemId: "q-A", text: "wrong session" });
  f.handler({ type: "queueDelete", queueItemId: "q-A" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["edit", "delete"]);
  f.dispose();
});

test("queue send-now stops after a pending model change loses session ownership", async () => {
  const f = fixture();
  let resolveRuntime!: (runtime: null) => void;
  f.state.pendingModel = { sessionId: "A", providerId: "provider", modelId: "new-model" };
  f.state.resolveSessionModelRuntime = () => new Promise(resolve => { resolveRuntime = resolve; });
  let sends = 0;
  (f.state.client as typeof f.state.client & { sendQueuedNow: () => Promise<void> }).sendQueuedNow = async () => { sends++; };
  f.handler({ type: "queueSendNow", sessionId: "A", queueItemId: "q-A" });
  f.switchToB();
  resolveRuntime(null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends, 0, "queued item was sent in the newly selected session");
  f.dispose();
});

test("file rewind requires the session that owns its turn target", async () => {
  const f = fixture();
  let rewinds = 0;
  (f.state.client as typeof f.state.client & { rewindTurnFiles: () => Promise<void> }).rewindTurnFiles = async () => { rewinds++; };
  f.switchToB();
  await f.state.onWebviewMessage({ type: "rewindFiles", sessionId: "A", rowId: 8, entityId: "turn-A" });
  await f.state.onWebviewMessage({ type: "rewindFiles", rowId: 8, entityId: "turn-A" });
  assert.equal(rewinds, 0, "A's file change target reached B");
  f.dispose();
});

test("provider quota adapters are gated by the authoritative desktop picker", () => {
  const authoritative = { providerInventoryAuthoritative: true, managedProviderIds: ["kimi"],
    picker: [{ providerId: "kimi", modelId: "kimi-k3", hasKey: true }] } as Parameters<typeof quotaProviderIsSelectable>[1];
  assert.equal(quotaProviderIsSelectable("kimi", authoritative), true);
  assert.equal(quotaProviderIsSelectable("deepseek", authoritative), false, "removed shortcut still exposes its quota");
  assert.equal(quotaProviderIsSelectable("builtin:bigmodel-coding-plan", authoritative), true);
  assert.equal(quotaProviderIsSelectable("deepseek", { ...authoritative, providerInventoryAuthoritative: false }), true,
    "an unreadable desktop inventory should preserve the existing fallback behavior");
});

test("queue reorder is scoped to the active session and forwards both queue IDs", async () => {
  const f = fixture();
  const calls: Array<[string, string | null]> = [];
  (f.state.client as typeof f.state.client & { reorderQueuedMessage: (id: string, before: string | null) => Promise<void> })
    .reorderQueuedMessage = async (id, before) => { calls.push([id, before]); };
  f.handler({ type: "queueReorder", sessionId: "B", queueItemId: "third", beforeQueueItemId: "first" });
  f.handler({ type: "queueReorder", sessionId: "A", queueItemId: "third", beforeQueueItemId: "first" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [["third", "first"]]);
  f.dispose();
});

test("late file list cannot populate the next session's file cards", async () => {
  const f = fixture();
  const loading = f.state.onWebviewMessage({ type: "loadFileChanges", rowId: 1, entityId: "turn-A", turnId: "A" });
  f.switchToB(); f.response.resolve([{ path: "from-A.ts" }]); await loading;
  assert.deepEqual(f.posted, []);
  f.dispose();
});

test("queue rejection belongs to that input, preserving the running turn", async () => {
  const f = fixture();
  f.handler({ type: "insert", sessionId: "A", text: "insert-A", queueItemId: "command-A" });
  f.response.reject(new Error("queue rejected"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.posted, [{ type: "queue_rejected", commandId: "command-A", sessionId: "A", text: "insert-A", chips: [], message: "queue rejected" }]);
  f.dispose();
});


test("late rejected send recovers only its original draft and preserves selected context", async () => {
  const f = fixture();
  const chips = [{ path: "/project/a.ts", relPath: "a.ts", selectedText: "captured" }];
  const sending = f.state.onWebviewMessage({ type: "send", sessionId: "A", commandId: "send-A", text: "draft-A", chips });
  f.switchToB(); f.response.reject(new Error("send failed")); await sending;
  assert.deepEqual(f.posted, [{ type: "send_rejected", sessionId: "A", commandId: "send-A", text: "draft-A", chips, message: "send failed" }]);
  f.dispose();
});
test("late accepted send acknowledges original input without indexing the new session", async () => {
  const f = fixture();
  let indexed = false; f.state.indexCurrentSession = () => { indexed = true; };
  const sending = f.state.onWebviewMessage({ type: "send", sessionId: "A", commandId: "send-A", text: "draft-A" });
  f.switchToB(); f.response.resolve(); await sending;
  assert.deepEqual(f.posted, [{ type: "send_admitted", sessionId: "A", commandId: "send-A" }]);
  assert.equal(indexed, false);
  f.dispose();
});
test("send for a stale session is rejected without calling the new session", async () => {
  const f = fixture();
  f.switchToB();
  let called = false; f.state.client.sendMessage = async () => { called = true; };
  await f.state.onWebviewMessage({ type: "send", sessionId: "A", commandId: "send-A", text: "draft-A" });
  assert.equal(called, false);
  assert.equal(f.posted[0].type, "send_rejected");
  assert.equal(f.posted[0].sessionId, "A");
  f.dispose();
});

test("/plan sends its task only after the owning session enters plan mode", async () => {
  const f = fixture();
  const order: string[] = [];
  f.state.client.setMode = async mode => { order.push(`mode:${mode}`); };
  f.state.client.sendMessage = async text => { order.push(`send:${String(text)}`); };
  await f.state.onWebviewMessage({
    type: "send", sessionId: "A", commandId: "plan-A", text: "Explain the change",
    planMode: true, recoveryText: "/plan Explain the change",
  });
  assert.deepEqual(order, ["mode:plan", "send:Explain the change"]);
  assert.deepEqual(f.posted, [{ type: "send_admitted", commandId: "plan-A", sessionId: "A" }]);
  f.dispose();
});

test("/plan does not send its task if the session changes during the mode switch", async () => {
  const f = fixture();
  let sends = 0;
  f.state.client.setMode = async () => { f.switchToB(); };
  f.state.client.sendMessage = async () => { sends++; };
  await f.state.onWebviewMessage({
    type: "send", sessionId: "A", commandId: "plan-A", text: "Explain the change",
    planMode: true, recoveryText: "/plan Explain the change",
  });
  assert.equal(sends, 0);
  assert.equal(f.posted[0].type, "send_rejected");
  assert.equal(f.posted[0].sessionId, "A");
  assert.equal(f.posted[0].text, "/plan Explain the change");
  f.dispose();
});

test("/plan mode failure restores the current mode and the complete retry command", async () => {
  const f = fixture();
  let sends = 0;
  f.state.client.setMode = async () => { throw new Error("mode unavailable"); };
  f.state.client.sendMessage = async () => { sends++; };
  await f.state.onWebviewMessage({
    type: "send", sessionId: "A", commandId: "plan-A", text: "Explain the change",
    planMode: true, recoveryText: "/plan Explain the change",
  });
  assert.equal(sends, 0);
  assert.deepEqual(f.posted.slice(0, 1), [{ type: "session_controls", mode: "build" }]);
  assert.equal(f.posted[1].type, "send_rejected");
  assert.equal(f.posted[1].text, "/plan Explain the change");
  f.dispose();
});

test("retryLast acknowledges admission and associates a rejected retry with its recovery draft", async () => {
  const f = fixture();
  f.state.client.sendMessage = async () => {};
  await f.state.onWebviewMessage({ type: "retryLast", sessionId: "A", commandId: "retry-ok", text: "QUESTION" });
  assert.deepEqual(f.posted, [{ type: "send_admitted", sessionId: "A", commandId: "retry-ok" }]);
  f.posted.length = 0;
  f.state.client.sendMessage = async () => { throw new Error("retry rejected"); };
  await f.state.onWebviewMessage({ type: "retryLast", sessionId: "A", commandId: "retry-failed", text: "EXPANDED_QUESTION", recoveryText: "ORIGINAL_QUESTION" });
  assert.deepEqual(f.posted, [{ type: "send_rejected", sessionId: "A", commandId: "retry-failed", text: "ORIGINAL_QUESTION", chips: [], message: "retry rejected" }]);
  f.dispose();
});

test("retryLast reapplies a rejected Plan shortcut before sending and restores controls on failure", async () => {
  const f = fixture();
  const order: string[] = [];
  f.state.client.setMode = async mode => { order.push(mode); };
  f.state.client.sendMessage = async text => { order.push(String(text)); };
  const retry = { type: "retryLast", sessionId: "A", commandId: "plan-retry", text: "Plan task", recoveryText: "/plan Plan task", planMode: true };
  await f.state.onWebviewMessage(retry);
  assert.deepEqual(order, ["plan", "Plan task"]);
  assert.deepEqual(f.posted, [{ type: "send_admitted", sessionId: "A", commandId: "plan-retry" }]);
  f.posted.length = 0;
  order.length = 0;
  f.state.client.setMode = async () => { throw new Error("mode unavailable"); };
  await f.state.onWebviewMessage(retry);
  assert.deepEqual(order, []);
  assert.deepEqual(f.posted, [
    { type: "session_controls", mode: "build" },
    { type: "send_rejected", sessionId: "A", commandId: "plan-retry", text: "/plan Plan task", chips: [], message: "mode unavailable" },
  ]);
  f.dispose();
});

test("retryLast cannot send into another session after reapplying Plan mode", async () => {
  const f = fixture();
  let sends = 0;
  f.state.client.setMode = async () => { f.switchToB(); };
  f.state.client.sendMessage = async () => { sends++; };
  await f.state.onWebviewMessage({ type: "retryLast", sessionId: "A", commandId: "plan-retry", text: "A task", planMode: true });
  assert.equal(sends, 0);
  assert.equal(f.posted.at(-1)?.type, "send_rejected");
  assert.equal(f.posted.at(-1)?.sessionId, "A");
  assert.equal(f.posted.at(-1)?.commandId, "plan-retry");
  f.dispose();
});

test("retryLast rejects the original question after the user switches sessions", async () => {
  const f = fixture();
  let sends = 0;
  f.state.client.sendMessage = async () => { sends++; };
  f.switchToB();
  await f.state.onWebviewMessage({ type: "retryLast", sessionId: "A", text: "QUESTION_FROM_A" });
  assert.equal(sends, 0, "retry sent A's question to the active B session");
  assert.deepEqual(f.posted.at(-1), {
    type: "send_rejected", sessionId: "A", text: "QUESTION_FROM_A", chips: [],
    message: "会话已切换，请在当前会话重新发送。",
  });
  f.dispose();
});

test("retryLast rechecks session ownership after applying a pending model", async () => {
  const f = fixture();
  const state = f.state as typeof f.state & {
    pendingModel: { sessionId: string; providerId: string; modelId: string } | null;
  };
  f.state.resolveSessionModelRuntime = async () => null;
  const modelChange = deferred();
  let sends = 0;
  f.state.client.setModel = () => modelChange.promise;
  f.state.client.sendMessage = async () => { sends++; };
  state.pendingModel = { sessionId: "A", providerId: "provider", modelId: "target" };
  const retry = f.state.onWebviewMessage({ type: "retryLast", sessionId: "A", text: "QUESTION_FROM_A" });
  await new Promise<void>(resolve => setImmediate(resolve));
  f.switchToB();
  modelChange.resolve();
  await retry;
  assert.equal(sends, 0, "retry sent after the active session changed during model setup");
  assert.ok(f.posted.some(message => message.type === "send_rejected" && message.sessionId === "A"));
  assert.ok(!f.posted.some(message => message.type === "send_admitted"));
  f.dispose();
});

for (const language of ["zh-CN", "zh-TW", "en"]) {
  test(`rename failure remains a localized management notice after switching (${language})`, async () => {
    setTestLanguage(language);
    try {
      const f = fixture();
      const state = f.state as unknown as {
        client: { renameSession: () => Promise<unknown> };
        applyRename: (id: string, title: string) => Promise<void>;
      };
      state.client.renameSession = () => f.response.promise;
      const rename = state.applyRename("A", "new name");
      f.switchToB(); f.response.reject(new Error("RPC refused")); await rename;
      assert.equal(f.posted.length, 1);
      assert.equal(f.posted[0].type, "toast");
      assert.match(String(f.posted[0].text), /RPC refused/);
      if (language === "en") assert.match(String(f.posted[0].text), /^Rename session could not be completed:/);
      if (language === "zh-TW") assert.match(String(f.posted[0].text), /^重新命名會話未能完成：/);
      assert.ok(!f.posted.some(message => message.type === "session_error"));
      f.dispose();
    } finally { setTestLanguage("auto"); }
  });
}


test("workspace mention search stays scoped and responses retain request ownership", async () => {
 const f = fixture(); const state = f.state as typeof f.state & {workspacePath:string}; state.workspacePath="/test/work";
 setTestFiles(["/test/work/src/main.ts","/test/work/.vscode/settings.json"]);
 await state.onWebviewMessage({type:"searchWorkspaceFiles",requestId:"search-A",sessionId:"A",text:"main"});
 assert.deepEqual(f.posted.pop(),{type:"workspace_files",requestId:"search-A",sessionId:"A",files:[{path:"/test/work/src/main.ts",relPath:"src/main.ts"}]});
 f.switchToB();
 await state.onWebviewMessage({type:"searchWorkspaceFiles",requestId:"search-B",sessionId:"B",text:"settings"});
 assert.deepEqual(f.posted.pop(),{type:"workspace_files",requestId:"search-B",sessionId:"B",files:[{path:"/test/work/.vscode/settings.json",relPath:".vscode/settings.json"}]});
 assert.deepEqual(f.posted,[]); setTestFiles([]);
  f.dispose();
});

test("typed file search uses targeted native patterns and cancels stale queries", async () => {
 const f=fixture();const state=f.state as typeof f.state & {workspacePath:string};state.workspacePath="/test/work";
 const finder=workspace as unknown as {findFiles:(pattern:{pattern:string},exclude:string,limit:number,token:{isCancellationRequested:boolean})=>Promise<Array<{fsPath:string}>>};
 const original=finder.findFiles;const pending=deferred();const tokens:Array<{isCancellationRequested:boolean}>=[];
 finder.findFiles=async(pattern,_exclude,limit,token)=>{assert.notEqual(pattern.pattern,"**/*");assert.equal(limit,5000);tokens.push(token);if(pattern.pattern.includes("[aA]"))return await pending.promise as Array<{fsPath:string}>;return [{fsPath:"/test/work/b.ts"}];};
 try {
  const first=state.onWebviewMessage({type:"searchWorkspaceFiles",requestId:"old-search",sessionId:"A",text:"a"});
  await state.onWebviewMessage({type:"searchWorkspaceFiles",requestId:"new-search",sessionId:"A",text:"b"});
  assert.equal(tokens[0].isCancellationRequested,true);pending.resolve([{fsPath:"/test/work/a.ts"}]);await first;
  assert.equal(f.posted.length,1);assert.equal(f.posted[0].requestId,"new-search");
 } finally {finder.findFiles=original;}
});

test("recovery buttons open only known settings and the fixed community destination", async()=>{
  const provider = new ZCodeViewProvider({extensionUri:"file:///unused",subscriptions:[]} as unknown as vscode.ExtensionContext);
  const state = provider as unknown as {onWebviewMessage:(message:Record<string,unknown>)=>Promise<void>};
  recoveryCalls.length=0;
  try {
    await state.onWebviewMessage({type:"openRecoverySettings",setting:"binaryPath"});
    await state.onWebviewMessage({type:"openRecoverySettings",setting:"nodePath"});
    await state.onWebviewMessage({type:"openRecoverySettings",setting:"arbitrary.command"});
    await state.onWebviewMessage({type:"openCommunity",url:"https://untrusted.invalid"});
    assert.deepEqual(recoveryCalls,[
      {command:"workbench.action.openSettings",args:["@id:zcode.binaryPath"]},
      {command:"workbench.action.openSettings",args:["@id:zcode.nodePath"]},
      {url:"https://marketplace.visualstudio.com/items?itemName=fanghua.zcode-desktop-chat#qna"},
    ]);
  } finally {recoveryCalls.length=0;provider.dispose();}
});

test("startup notifications describe the exact setting and include actionable buttons",()=>{
  const provider=new ZCodeViewProvider({extensionUri:"file:///unused",subscriptions:[]} as unknown as vscode.ExtensionContext);
  const state=provider as unknown as {showStartupError:(message:string)=>void};
  recoveryNotices.length=0;
  try {
    setTestLanguage("en");state.showStartupError("zcode.binaryPath does not exist");
    assert.match(recoveryNotices[0].message,/full path of resources\/glm\/zcode.cjs/);
    assert.deepEqual(recoveryNotices[0].items,["Set ZCode path","Open log","Ask the community"]);
  } finally {setTestLanguage("auto");recoveryNotices.length=0;provider.dispose();}
});


test("reasoning changes reject missing or foreign ownership and suppress stale failures", async () => {
  const f = fixture();
  const client = f.state.client as typeof f.state.client & {setThoughtLevel:(level:string)=>Promise<void>};
  const pending = deferred(); const calls:string[]=[];
  client.setThoughtLevel = async level => { calls.push(level); await pending.promise; };
  recoveryNotices.length = 0;
  await f.state.onWebviewMessage({type:"setThoughtLevel",thoughtLevel:"high"});
  await f.state.onWebviewMessage({type:"setThoughtLevel",sessionId:"B",viewGen:f.state.switchTicket,thoughtLevel:"high"});
  assert.deepEqual(calls, []);
  const operation = f.state.onWebviewMessage({type:"setThoughtLevel",sessionId:"A",viewGen:f.state.switchTicket,thoughtLevel:"low"});
  assert.deepEqual(calls, ["low"]);
  f.switchToB(); pending.reject(new Error("old failure")); await operation;
  assert.deepEqual(recoveryNotices, []);
  f.state.client.currentSessionId = "A";
  await f.state.onWebviewMessage({type:"setThoughtLevel",sessionId:"A",viewGen:f.state.switchTicket-1,thoughtLevel:"high"});
  assert.deepEqual(calls,["low"]);
  f.dispose();
});

test("a model QuickPick result belongs to the chat and switch generation that opened it", async () => {
  const f = fixture();
  const pick = deferred();
  const original = testWindow.showQuickPick;
  testWindow.showQuickPick = async () => pick.promise;
  const model = {providerId:"vendor",modelId:"model",providerName:"Vendor",kind:"openai-compatible",label:"Model",hasKey:true};
  f.state.picker = [model];
  const selected:unknown[]=[];
  (f.state as unknown as {selectModel:(...args:unknown[])=>Promise<void>}).selectModel = async (...args) => { selected.push(args); };
  try {
    const operation = (f.state as unknown as {quickSelectModel:()=>Promise<void>}).quickSelectModel();
    f.switchToB(); f.state.client.currentSessionId = "A";
    pick.resolve({m:model}); await operation;
    assert.deepEqual(selected, [], "returning to the same chat must not revive an old picker");
    testWindow.showQuickPick = async () => ({m:model});
    await (f.state as unknown as {quickSelectModel:()=>Promise<void>}).quickSelectModel();
    assert.deepEqual(selected, [["vendor","model"]]);
  } finally { testWindow.showQuickPick = original; }
});

test("local file link line ranges reach the editor while workspace containment still applies", async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"zcode-line-link-"));
  try {
    fs.writeFileSync(path.join(root,"source#draft.ts"),"first\nsecond\nthird\n");
    const f=fixture();(f.state as typeof f.state & {workspacePath:string}).workspacePath=root;
    recoveryCalls.length=0;
    await f.state.onWebviewMessage({type:"openMarkdownFile",sessionId:"A",path:"./source#draft.ts",line:2,endLine:3});
    const options=recoveryCalls.at(-1)?.args?.[1] as {selection:{start:{line:number};end:{line:number}}};
    assert.equal(options.selection.start.line,1);assert.equal(options.selection.end.line,2);
    const count=recoveryCalls.length;
    await f.state.onWebviewMessage({type:"openMarkdownFile",sessionId:"A",path:"../outside.ts",line:2});
    assert.equal(recoveryCalls.length,count);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test("edit rejection returns its attempt and command identity for draft-preserving recovery", async () => {
  const f=fixture();
  f.state.client.editUserQuery=async()=>{throw new Error("EDIT_FAILED");};
  await f.state.onWebviewMessage({type:"editLast",sessionId:"A",viewGen:f.state.switchTicket,editRequestId:"attempt",commandId:"submission",rowId:2,entityId:"question",text:"KEEP_EDIT"});
  assert.deepEqual(f.posted,[{type:"query_edit_rejected",sessionId:"A",viewGen:f.state.switchTicket,editRequestId:"attempt",commandId:"submission",entityId:"question",message:"EDIT_FAILED"}]);
  f.dispose();
});


for (const type of ["loadOlder", "loadThrough"]) test(`${type} failures have a retryable response without changing session status`, async () => {
  const f = fixture();
  Object.assign(f.state.client, { olderMessages: () => f.response.promise });
  const action = f.state.onWebviewMessage({ type, sessionId: "A", viewGen: f.state.switchTicket,
    requestId: "history-attempt", oldestId: "oldest", messageId: "target" });
  f.response.reject(new Error("Simulated page failure"));
  await action;
  assert.deepEqual(f.posted, [{ type: "history_load_failed", sessionId: "A", viewGen: f.state.switchTicket,
    requestId: "history-attempt", ...(type === "loadThrough" ? { jumpId: "target" } : {}), message: "Simulated page failure" }]);
  Object.assign(f.state.client, { olderMessages: async () => ({ items: [{ id: "earlier", role: "user", text: "EARLIER_TEXT" }], more: false }) });
  await f.state.onWebviewMessage({ type, sessionId: "A", viewGen: f.state.switchTicket,
    requestId: "history-retry", oldestId: "oldest", messageId: "target" });
  assert.deepEqual(f.posted.at(-1), { type: "historyOlder", sessionId: "A", viewGen: f.state.switchTicket,
    requestId: "history-retry", items: [{ id: "earlier", role: "user", text: "EARLIER_TEXT" }], more: false,
    ...(type === "loadThrough" ? { jumpId: "target" } : {}) });
  f.dispose();
});

test("history failures and success replies cannot reach a newly selected session", async () => {
  for (const fail of [false, true]) {
    const f = fixture();
    Object.assign(f.state.client, { olderMessages: () => f.response.promise });
    const action = f.state.onWebviewMessage({ type: "loadOlder", sessionId: "A", viewGen: f.state.switchTicket, oldestId: "oldest" });
    f.switchToB();
    if (fail) f.response.reject(new Error("Late failure"));
    else f.response.resolve({ items: [], more: true });
    await action;
    assert.deepEqual(f.posted, []);
    f.dispose();
  }
});

test("queue edit replies retain attempt ownership after a session switch", async () => {
  for (const fail of [false, true]) {
    const f = fixture();
    Object.assign(f.state.client, { editQueuedMessage: () => f.response.promise });
    const viewGen = f.state.switchTicket;
    f.handler({ type: "queueEdit", sessionId: "A", queueItemId: "item", text: "REPLACEMENT", requestId: "queue-attempt", viewGen });
    f.switchToB();
    if (fail) f.response.reject(new Error("Queue rejected"));
    else f.response.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.posted, [{ type: "queue_edit_result", sessionId: "A", queueItemId: "item",
      requestId: "queue-attempt", viewGen, ok: !fail, ...(fail ? { message: "Queue rejected" } : {}) }]);
    f.dispose();
  }
});


for (const control of ["mode", "thought"]) test(`failed ${control} changes restore full confirmed controls and suppress late failures`, async () => {
  for (const switchAway of [false, true]) {
    const f = fixture();
    const confirmed = { mode: "plan", baseMode: "build", planEnabled: true, thoughtEnabled: true,
      thoughtLevel: "low", thoughtLevels: [{ value: "low", label: "Low" }] };
    Object.assign(f.state.client, { confirmedControls: () => confirmed,
      setMode: () => f.response.promise, setThoughtLevel: () => f.response.promise });
    recoveryNotices.length = 0;
    const action = f.state.onWebviewMessage({ type: control === "mode" ? "setMode" : "setThoughtLevel",
      sessionId: "A", viewGen: f.state.switchTicket, mode: "yolo", thoughtLevel: "high" });
    if (switchAway) f.switchToB();
    f.response.reject(new Error("CONTROL_REJECTED"));
    await action;
    assert.deepEqual(f.posted, switchAway ? [] : [{ type: "session_controls", ...confirmed }]);
    assert.equal(recoveryNotices.length, switchAway ? 0 : 1);
    f.dispose();
  }
});

for (const phase of ["resolve", "switch"]) test(`model ${phase} failure restores the current model selection`, async () => {
  const f = fixture();
  const current = { providerId: "sample", modelId: "confirmed" };
  f.state.currentModel = { providerId: "sample", modelId: "pending-display" };
  Object.assign(f.state.client, { confirmedModel: () => current, isGenerating: () => false, setModel: async () => { throw new Error("MODEL_REJECTED"); } });
  f.state.resolveSessionModelRuntime = async () => {
    if (phase === "resolve") throw new Error("MODEL_RESOLUTION_REJECTED");
    return null;
  };
  f.state.pushModels = async () => { f.posted.push({ type: "models", current: f.state.currentModel }); };
  await (f.state as unknown as {selectModel:(provider: string, model: string) => Promise<void>}).selectModel("sample", "rejected");
  assert.deepEqual(f.posted, [{ type: "models", current }]);
  assert.deepEqual(f.state.currentModel, current);
  f.dispose();
});

test("choosing a model while generating stages it for quota display", async () => {
  const f = fixture();
  Object.assign(f.state.client, { isGenerating: () => true });

  await (f.state as unknown as {selectModel:(provider: string, model: string) => Promise<void>}).selectModel("deepseek", "deepseek-chat");

  assert.deepEqual(f.state.pendingModel, { sessionId: "A", providerId: "deepseek", modelId: "deepseek-chat" });
  assert.deepEqual(f.stagedModels(), { providerId: "deepseek", modelId: "deepseek-chat" });
  assert.deepEqual(f.posted.find(message => message.type === "models")?.current, {
    providerId: "deepseek",
    modelId: "deepseek-chat",
  });
  f.dispose();
});

test("loading older session pages exposes active sessions hidden behind archived records", async () => {
  const f = fixture();
  const state = f.provider as unknown as {
    client: {listSessionsPage:(archived:boolean,limit:number)=>Promise<{sessions:Array<{sessionId:string;title:string;archivedAt?:number}>;hasMore:boolean}>};
    refreshSessions:(archived?:boolean,startupList?:unknown,visible?:boolean,more?:boolean)=>Promise<void>;
    sessionListLimit:number;
  };
  const archived = Array.from({length:80},(_,i)=>({sessionId:`archived-${i}`,title:`Old ${i}`,archivedAt:1}));
  const active = {sessionId:"older-active",title:"Older active conversation"};
  const limits:number[]=[];
  state.client.listSessionsPage=async(_archived,limit)=>{limits.push(limit);return {sessions:limit===80?archived:[...archived,active],hasMore:limit===80};};
  await state.refreshSessions(false,undefined,true);
  assert.deepEqual(f.posted.at(-1)?.sessions,[]);
  assert.equal(f.posted.at(-1)?.hasMore,true);
  await f.state.onWebviewMessage({type:"listSessions",listVisible:true,loadMore:true});
  assert.deepEqual(limits,[80,160]);
  assert.deepEqual((f.posted.at(-1)?.sessions as Array<{sessionId:string}>).map(session=>session.sessionId),[active.sessionId]);
  assert.deepEqual(f.posted.at(-1)?.referenceSessions,[active]);
  assert.equal(f.posted.at(-1)?.hasMore,false);
  await state.refreshSessions(false,undefined,true);
  assert.equal(limits.at(-1),160,"a refresh must not silently truncate an expanded list");
});

test("failed load-more retains its page and workspace changes reset the limit", async () => {
  const f=fixture();
  const state=f.provider as unknown as {
    client:{listSessionsPage:(archived:boolean,limit:number)=>Promise<{sessions:Array<{sessionId:string;title:string}>;hasMore:boolean}>};
    refreshSessions:(archived?:boolean,startupList?:unknown,visible?:boolean,more?:boolean)=>Promise<void>;
    sessionListLimit:number;adoptWorkspace:(path:string)=>void;
  };
  state.adoptWorkspace("/project-a");
  const cached={sessionId:"cached",title:"Existing chat"};
  state.client.listSessionsPage=async()=>({sessions:[cached],hasMore:true});
  await state.refreshSessions(false,undefined,true);
  state.client.listSessionsPage=async()=>{throw Error("temporarily unavailable");};
  await state.refreshSessions(false,undefined,true,true);
  assert.equal(state.sessionListLimit,80);
  assert.equal(f.posted.at(-1)?.notice,"stale");
  assert.equal(f.posted.at(-1)?.hasMore,true);
  assert.deepEqual((f.posted.at(-1)?.sessions as Array<{sessionId:string}>).map(session=>session.sessionId),[cached.sessionId]);
  state.adoptWorkspace("/project-b");
  assert.equal(state.sessionListLimit,80);
  assert.deepEqual(f.posted.at(-1)?.sessions,[]);
});

test("quick switch can load past a page consisting only of archived sessions", async t => {
  const f=fixture();
  const state=f.provider as unknown as {client:{listSessionsPage:(archived:boolean,limit:number)=>Promise<{sessions:Array<{sessionId:string;title:string;archivedAt?:number}>;hasMore:boolean}>}};
  state.client.listSessionsPage=async(_archived,limit)=>({sessions:limit===80?[{sessionId:"old",title:"Archived",archivedAt:1}]:[{sessionId:"active",title:"Active"}],hasMore:limit===80});
  t.mock.method(testWindow,"showQuickPick",async (items: Array<{sessionId?:string;loadMore?:boolean}>)=>items[0]);
  const selected:string[]=[];
  t.mock.method(f.provider as unknown as {switchSession:(id:string)=>Promise<void>},"switchSession",async (id:string)=>{selected.push(id);});
  await f.provider.quickSwitchSession();
  assert.deepEqual(selected,["active"]);
});

test("a rejected slow-startup guidance action reports failure instead of escaping its caller", async () => {
  const f=fixture();
  const state=f.provider as unknown as {finishTiming:(timing:{dispose:()=>void;snapshot:()=>Record<string,string|number>})=>void;offerDefenderExclusion:()=>Promise<void>};
  Object.assign(f.state.client,{clearTiming:()=>{}});
  const descriptor=Object.getOwnPropertyDescriptor(process,"platform")!;
  Object.defineProperty(process,"platform",{value:"win32"});
  recoveryNotices.length=0;
  state.offerDefenderExclusion=async()=>{throw Error("CLIPBRD_E_CANT_OPEN");};
  try {
    state.finishTiming({dispose(){},snapshot:()=>({kind:"open","session/resume":21000})});
    await new Promise(resolve=>setImmediate(resolve));
    assert.ok(recoveryNotices.some(notice=>notice.message.includes("启动提示操作未完成")));
  }finally{Object.defineProperty(process,"platform",descriptor);}
});

test("a superseded foreground page still completes when its hidden replacement fails", async () => {
  const f=fixture();
  const state=f.provider as unknown as {
    client:{listSessions:()=>Promise<unknown[]>;listSessionsPage:()=>Promise<{sessions:Array<{sessionId:string;title:string}>;hasMore:boolean}>};
    refreshSessions:(archived?:boolean,startupList?:unknown,visible?:boolean,more?:boolean)=>Promise<void>;
  };
  state.client.listSessionsPage=async()=>({sessions:[{sessionId:"A",title:"Cached"}],hasMore:true});
  await state.refreshSessions(false,undefined,true);
  let release!:(page:{sessions:Array<{sessionId:string;title:string}>;hasMore:boolean})=>void;
  state.client.listSessionsPage=()=>new Promise(resolve=>{release=resolve;});
  const more=f.state.onWebviewMessage({type:"listSessions",listVisible:true,loadMore:true,requestId:"foreground-more"});
  state.client.listSessions=async()=>{throw Error("hidden refresh failed");};
  await state.refreshSessions(false);
  release({sessions:[{sessionId:"late",title:"Stale page"}],hasMore:false});
  await more;
  assert.equal(f.posted.filter(message=>message.type==="sessions").length,1,"a hidden failure or obsolete page replaced cached rows");
  assert.deepEqual(f.posted.at(-1),{type:"session_list_complete",requestId:"foreground-more"});
});
