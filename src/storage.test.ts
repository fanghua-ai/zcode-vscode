import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { runtimeEnv, readConfiguredDefaultModel, readCliDefaultModel, syncCliConfig, type ResolvedRuntime } from "./desktop";
import { cleanupOrphanedSqliteSnapshots, listWorkspacePathVariants, loadOverriddenTitles, upsertDesktopTask, loadTaskFlags, setTaskDeleted, setTaskArchived } from "./taskIndex";
import { ZCodeClient } from "./zcodeClient";
import { activate, ZCodeViewProvider } from "./extension";
import { setTestConfirmation, getRegisteredProvider } from "./testSupport/vscode";

// Each test file runs in its own process. Redirect all desktop paths to fake data.
const os = require("os") as typeof import("os");
interface Database {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): Record<string, unknown> };
  close(): void;
}
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (file: string) => Database };

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-storage-test-"));
  const original = os.homedir;
  os.homedir = () => root;
  const index = path.join(root, ".zcode/v2/tasks-index.sqlite");
  fs.mkdirSync(path.dirname(index), { recursive: true });
  const db = new DatabaseSync(index);
  db.exec(`CREATE TABLE tasks (
    workspace_key TEXT, workspace_path TEXT, workspace_identity TEXT, task_id TEXT,
    title TEXT, task_status TEXT, provider TEXT, mode TEXT, model TEXT, created_at INTEGER,
    updated_at INTEGER, last_unread_at INTEGER, pinned INTEGER DEFAULT 0,
    archived INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, title_overridden INTEGER DEFAULT 0,
    meta_json TEXT, searchable_text TEXT, PRIMARY KEY(workspace_key,task_id))`);
  t.after(() => { db.close(); os.homedir = original; fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db };
}

test("refreshing a paginated list keeps older and other-provider desktop tasks", async (t) => {
  const { db } = fixture(t);
  for (let i = 0; i < 82; i++) {
    db.prepare("INSERT INTO tasks(workspace_key,task_id,title,provider,pinned) VALUES(?,?,?,?,?)")
      .run("/project", `s${i}`, `saved ${i}`, i === 81 ? "other-agent" : "glm", 1);
  }
  const subscriptions: vscode.Disposable[] = [];
  const context = { subscriptions, workspaceState: { get: () => undefined } } as unknown as vscode.ExtensionContext;
  activate(context);
  t.after(() => subscriptions.forEach((subscription) => subscription.dispose()));
  const provider = getRegisteredProvider() as {
    workspacePath: string;
    client: unknown;
    refreshSessions(): Promise<void>;
  };
  provider.workspacePath = "/project";
  provider.client = {
    currentSessionId: null,
    dispose() {},
    listSessions: async () => Array.from({ length: 80 }, (_, i) => ({ sessionId: `s${i}`, title: `listed ${i}` })),
  };
  await provider.refreshSessions();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 82);
  assert.deepEqual({ ...db.prepare("SELECT title,pinned FROM tasks WHERE task_id='s80'").get() }, { title: "saved 80", pinned: 1 });
  assert.equal(db.prepare("SELECT provider FROM tasks WHERE task_id='s81'").get().provider, "other-agent");
  provider.client = null;
});

test("native WAL writes remain durable", (t) => {
  const { db } = fixture(t);
  db.exec("PRAGMA journal_mode=WAL");
  db.prepare("INSERT INTO tasks(workspace_key,task_id) VALUES(?,?)").run("/project", "native");
  setTaskArchived("/project", "native", true);
  assert.equal(db.prepare("SELECT archived FROM tasks WHERE task_id='native'").get().archived, 1);
  setTaskDeleted("/project", "native");
  assert.equal(db.prepare("SELECT deleted FROM tasks WHERE task_id='native'").get().deleted, 1);
});

test("CLI config permissions protect new keys and repair existing permissive files", (t) => {
  const { root } = fixture(t);
  const runtime: ResolvedRuntime = {
    providerId: "custom:test", providerName: "Test", modelId: "test", models: {},
    kind: "openai-compatible", baseURL: "https://example.invalid", apiKey: "FAKE-TEST-KEY", source: "custom-provider",
  };
  const config = syncCliConfig(runtime, { provider: {} });
  assert.ok(config.startsWith(root));
  assert.equal(JSON.parse(fs.readFileSync(config, "utf8")).provider["custom:test"].options.apiKey, "FAKE-TEST-KEY");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(config).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(config)).mode & 0o777, 0o700);
    fs.chmodSync(config, 0o644);
    fs.chmodSync(path.dirname(config), 0o755);
    syncCliConfig({ ...runtime, apiKey: "FAKE-REPLACEMENT" }, { provider: {} });
    assert.equal(fs.statSync(config).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(config)).mode & 0o777, 0o700);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(config)), ["config.json"]);
});

test("CLI sync does not restore providers or defaults removed from the authoritative desktop registry", t => {
  const { root } = fixture(t);
  const v2 = path.join(root, ".zcode", "v2");
  const cliDir = path.join(root, ".zcode", "cli");
  fs.mkdirSync(v2, { recursive: true });
  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(path.join(v2, "provider_config.json"), JSON.stringify({ config: { providerConfigRules: { providerRules: [] } } }));
  const stale = { name: "Removed", kind: "openai-compatible", options: { apiKey: "TEST-ONLY-STALE", baseURL: "https://removed.example/v1" }, models: { old: {} } };
  fs.writeFileSync(path.join(v2, "config.json"), JSON.stringify({ provider: { removed: stale } }));
  fs.writeFileSync(path.join(cliDir, "config.json"), JSON.stringify({ model: "removed/old", provider: { removed: stale } }));
  const runtime: ResolvedRuntime = {
    providerId: "account:bigmodel-team-coding-plan", providerName: "BigModel", modelId: "GLM-5.3-Flash", models: {},
    kind: "openai", baseURL: "https://example.invalid", apiKey: "TEST-ONLY-ACCOUNT", source: "desktop-team-oauth",
  };
  const file = syncCliConfig(runtime, { provider: { removed: stale } }, false);
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(config.provider.removed, undefined, "stale provider key was copied back into CLI config");
  assert.equal(config.model, undefined, "stale CLI model remained the default for a new session");
});

for (const scenario of ["active", "empty", "inactive", "switch", "failure"] as const) {
  test(`archive reconciles stale backend list with persisted flags (${scenario})`, async t => {
    const { db } = fixture(t);
    for (const [id, archived, deleted] of [["A", 0, 0], ["ARCHIVED", 1, 0], ["DELETED", 0, 1]] as const) {
      db.prepare("INSERT INTO tasks(workspace_key,task_id,title,archived,deleted) VALUES(?,?,?,?,?)").run("/project", id, id, archived, deleted);
    }
    const provider = new ZCodeViewProvider({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    const posted: Array<{ type: string; text?: string }> = [];
    const state = provider as unknown as {
      workspacePath: string; switchTicket: number;
      client: { currentSessionId: string; listSessions: () => Promise<Array<{sessionId:string;archivedAt?:number}>> };
      post: (message: { type: string; text?: string }) => void;
      refreshSessions: () => Promise<void>; newSession: () => Promise<void>;
      switchSession: (id:string) => Promise<void>;
      archiveSession: (id: string, archived: boolean) => Promise<void>;
    };
    state.workspacePath = "/project";
    state.client = { currentSessionId: scenario === "inactive" ? "B" : "A", listSessions: async () => {
      if (scenario === "failure") throw new Error("offline");
      if (scenario === "switch") { state.client.currentSessionId = "B"; state.switchTicket++; }
      // A previously archived chat remains first in the cached server list.
      return [{sessionId:"ARCHIVED"},{sessionId:"DELETED"},{sessionId:"A"},
        {sessionId:"SERVER_ARCHIVED",archivedAt:1}, ...(scenario === "empty" ? [] : [{sessionId:"VALID"}])];
    }};
    state.post = message => posted.push(message); state.refreshSessions = async () => {};
    let creations = 0; const switches:string[]=[];
    state.newSession = async () => { creations++; state.client.currentSessionId = "NEW"; };
    state.switchSession = async id => { switches.push(id); state.client.currentSessionId=id; };
    await state.archiveSession("A", true);
    assert.equal(db.prepare("SELECT archived FROM tasks WHERE task_id='A'").get().archived, 1);
    assert.deepEqual(switches, scenario === "active" ? ["VALID"] : []);
    assert.equal(creations, scenario === "empty" ? 1 : 0);
    if (scenario === "inactive" || scenario === "switch") assert.equal(state.client.currentSessionId,"B");
    if (scenario === "failure") assert.deepEqual(posted,[{type:"toast",text:"归档会话已保存，但后续同步未完成：offline"}]);
    else assert.equal(posted.at(-1)?.text,"会话已归档");
    if (scenario === "active") {
      // Reproduce archive A -> create C -> archive C. The server still returns
      // A without an archive timestamp, but the SQLite flag must exclude it.
      db.prepare("INSERT INTO tasks(workspace_key,task_id,title) VALUES(?,?,?)").run("/project","C","C");
      state.client.currentSessionId="C";
      state.client.listSessions=async()=>[{sessionId:"A"},{sessionId:"C"},{sessionId:"VALID"}];
      await state.archiveSession("C",true);
      assert.deepEqual(switches,["VALID","VALID"]);
      assert.equal(creations,0);
      assert.equal(db.prepare("SELECT archived FROM tasks WHERE task_id='C'").get().archived,1);
    }
  });
}

for (const scenario of ["stale", "racing", "empty", "switch", "failure"] as const) {
  test(`delete reconciles stale backend list with persisted flags (${scenario})`, async t => {
    const { db } = fixture(t);
    for (const [id, archived, deleted] of [["A", 1, 0], ["ARCHIVED", 1, 0], ["DELETED", 0, 1], ["VALID", 0, 0], ["OLDER", 0, 0]] as const) {
      db.prepare("INSERT INTO tasks(workspace_key,task_id,title,archived,deleted) VALUES(?,?,?,?,?)").run("/project", id, id, archived, deleted);
    }
    setTestConfirmation(true);
    t.after(() => setTestConfirmation(false));
    const provider = new ZCodeViewProvider({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    const posted: Array<{ type: string; text?: string }> = [];
    const state = provider as unknown as {
      workspacePath: string; switchTicket: number; sessions: Array<{ sessionId: string; archivedAt?: number }>;
      client: { currentSessionId: string; listSessions: () => Promise<Array<{sessionId:string;archivedAt?:number}>> };
      post: (message: { type: string; text?: string }) => void;
      refreshSessions: (includeArchived?: boolean) => Promise<void>; newSession: () => Promise<void>;
      switchSession: (id: string) => Promise<void>;
      deleteSession: (id: string) => Promise<void>;
    };
    state.workspacePath = "/project";
    state.sessions = [{ sessionId: "A", archivedAt: 1 }];
    state.client = { currentSessionId: "A", listSessions: async () => {
      if (scenario === "failure") throw new Error("offline");
      if (scenario === "switch") { state.client.currentSessionId = "B"; state.switchTicket++; }
      if (scenario === "racing") setTaskArchived("/project", "VALID", true);
      return [{sessionId:"ARCHIVED"},{sessionId:"DELETED"},{sessionId:"A"},
        {sessionId:"SERVER_ARCHIVED",archivedAt:1}, ...(scenario === "empty" ? [] : [{sessionId:"VALID"},{sessionId:"OLDER"}])];
    }};
    state.post = message => posted.push(message);
    const refreshedTabs: boolean[] = [];
    state.refreshSessions = async (includeArchived = false) => { refreshedTabs.push(includeArchived); };
    let creations = 0; const switches: string[] = [];
    state.newSession = async () => { creations++; state.client.currentSessionId = "NEW"; };
    state.switchSession = async id => { switches.push(id); state.client.currentSessionId = id; };
    await state.deleteSession("A");
    assert.equal(db.prepare("SELECT deleted FROM tasks WHERE task_id='A'").get().deleted, 1);
    assert.deepEqual(switches, scenario === "stale" ? ["VALID"] : scenario === "racing" ? ["OLDER"] : []);
    assert.equal(creations, scenario === "empty" ? 1 : 0);
    if (scenario === "switch") assert.equal(state.client.currentSessionId, "B");
    if (scenario === "failure") assert.deepEqual(posted, [{type:"toast", text:"删除会话已保存，但后续同步未完成：offline"}]);
    else assert.equal(posted.at(-1)?.text, "会话已删除");
    // Deleting starts from the archived tab; the refreshed list must keep the
    // webview there instead of flipping it back to the active tab.
    if (scenario === "failure") assert.deepEqual(refreshedTabs, []);
    else assert.deepEqual(refreshedTabs, [true]);
  });
}

test("choosing an archived session keeps the current conversation", async t => {
  const { db } = fixture(t);
  db.prepare("INSERT INTO tasks(workspace_key,task_id,title,archived) VALUES(?,?,?,1)").run("/project", "ARCHIVED", "old");
  db.prepare("INSERT INTO tasks(workspace_key,task_id,title,archived) VALUES(?,?,?,1)").run("/project", "FLAGS_ONLY", "flagged");
  const provider = new ZCodeViewProvider({ subscriptions: [] } as unknown as vscode.ExtensionContext);
  const posted: Array<{ type: string; text?: string }> = [];
  const resumed: string[] = [];
  const state = provider as unknown as {
    workspacePath: string;
    sessions: Array<{ sessionId: string; archivedAt?: number }>;
    client: { currentSessionId: string; switchSession: (id: string) => Promise<unknown> };
    post: (message: { type: string; text?: string }) => void;
    switchSession: (id: string) => Promise<void>;
  };
  state.workspacePath = "/project";
  state.sessions = [{ sessionId: "ARCHIVED", archivedAt: 1 }];
  state.client = {
    currentSessionId: "A",
    switchSession: async (id) => { resumed.push(id); return { items: [], truncated: false }; },
  };
  state.post = message => posted.push(message);
  await state.switchSession("ARCHIVED");
  await state.switchSession("FLAGS_ONLY");
  assert.deepEqual(resumed, []);
  assert.equal(state.client.currentSessionId, "A");
  assert.equal(db.prepare("SELECT archived FROM tasks WHERE task_id='ARCHIVED'").get().archived, 1);
  assert.deepEqual(posted.map(message => message.text), ["请先取消归档再打开", "请先取消归档再打开"]);
});

test("a model chosen during a reply applies on the next question", async () => {
  const stored = new Map<string, unknown>();
  const provider = new ZCodeViewProvider({
    subscriptions: [],
    workspaceState: {
      get: (key: string) => stored.get(key),
      update: async (key: string, value: unknown) => { stored.set(key, value); },
    },
  } as unknown as vscode.ExtensionContext);
  const commands: string[] = [];
  let generating = true;
  const posted: Array<{ type: string; current?: { modelId: string } }> = [];
  const state = provider as unknown as {
    client: {
      currentSessionId: string;
      isGenerating: () => boolean;
      setModel: (providerId: string, modelId: string) => Promise<void>;
      sendMessage: () => Promise<void>;
    };
    post: (message: { type: string; current?: { modelId: string } }) => void;
    selectModel: (providerId: string, modelId: string) => Promise<void>;
    handleZCodeEvent: (event: { type: string; data: { providerId: string; modelId: string } }) => void;
    onWebviewMessage: (msg: { type: string; text?: string; sessionId?: string }) => Promise<void>;
    currentModel?: { modelId: string };
    resolveSessionModelRuntime: (model: { providerId: string; modelId: string }) => Promise<import("./desktop").ResolvedRuntime | null | false>;
  };
  state.client = {
    currentSessionId: "A",
    isGenerating: () => generating,
    setModel: async (providerId, modelId) => { commands.push(`model:${providerId}/${modelId}`); },
    sendMessage: async () => { commands.push("send"); },
  };
  state.post = message => posted.push(message);
  state.resolveSessionModelRuntime = async () => null;
  await state.selectModel("p", "next");
  assert.deepEqual(commands, []);
  assert.equal(posted.at(-1)?.current?.modelId, "next");
  state.handleZCodeEvent({ type: "model_info", data: { providerId: "p", modelId: "old" } });
  assert.equal(state.currentModel?.modelId, "next");
  generating = false;
  await state.onWebviewMessage({ type: "send", text: "next question", sessionId: "A" });
  assert.deepEqual(commands, ["model:p/next", "send"]);
});

test("startup skips a remembered session the desktop index has archived or deleted", t => {
  const { db } = fixture(t);
  for (const [id, archived, deleted] of [["REMEMBERED", 1, 0], ["GONE", 0, 1], ["VALID", 0, 0]] as const) {
    db.prepare("INSERT INTO tasks(workspace_key,task_id,title,archived,deleted) VALUES(?,?,?,?,?)").run("/project", id, id, archived, deleted);
  }
  const provider = new ZCodeViewProvider({ subscriptions: [] } as unknown as vscode.ExtensionContext);
  const state = provider as unknown as {
    workspacePath: string;
    chooseStartupSession: (
      listed: Array<{ sessionId: string; title: string; archivedAt?: number }>,
      remembered: string | undefined,
      rejected: ReadonlySet<string>
    ) => string | undefined;
  };
  state.workspacePath = "/project";
  const listed = [
    { sessionId: "REMEMBERED", title: "old" },
    { sessionId: "GONE", title: "gone" },
    { sessionId: "SERVER_ARCHIVED", title: "server", archivedAt: 1 },
    { sessionId: "VALID", title: "valid" },
  ];
  assert.equal(state.chooseStartupSession(listed, "REMEMBERED", new Set()), "VALID");
  assert.equal(state.chooseStartupSession(listed, "GONE", new Set()), "VALID");
  assert.equal(state.chooseStartupSession(listed, "SERVER_ARCHIVED", new Set()), "VALID");
  assert.equal(state.chooseStartupSession([], "UNLISTED", new Set()), "UNLISTED");
  db.prepare("INSERT INTO tasks(workspace_key,task_id,title,deleted) VALUES(?,?,?,1)").run("/project", "UNLISTED", "unlisted");
  assert.equal(state.chooseStartupSession(listed, "UNLISTED", new Set()), "VALID");
  assert.equal(state.chooseStartupSession([{ sessionId: "REMEMBERED", title: "old", archivedAt: 1 }], "REMEMBERED", new Set()), undefined);
  assert.equal(state.chooseStartupSession(listed, "VALID", new Set(["VALID"])), undefined);
});

for (const action of ["rename", "delete", "archive"]) {
  test(`${action} database failure reports an operation notice, not a conversation error`, async t => {
    const { db } = fixture(t);
    db.exec("DROP TABLE tasks");
    setTestConfirmation(true); t.after(() => setTestConfirmation(false));
    const provider = new ZCodeViewProvider({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    const posted: Array<{ type: string; text?: string }> = [];
    const state = provider as unknown as {
      workspacePath: string;
      sessions: Array<{ sessionId: string; archivedAt: number }>;
      post: (message: { type: string; text?: string }) => void;
      applyRename: (id: string, title: string) => Promise<void>;
      deleteSession: (id: string) => Promise<void>;
      archiveSession: (id: string, archived: boolean) => Promise<void>;
    };
    state.workspacePath = "/project";
    state.sessions = [{ sessionId: "A", archivedAt: 1 }];
    state.post = message => posted.push(message);
    if (action === "rename") await state.applyRename("A", "new name");
    if (action === "delete") await state.deleteSession("A");
    if (action === "archive") await state.archiveSession("A", true);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].type, "toast");
    assert.match(posted[0].text!, /未能完成/);
  });
}

function windowsPlatform(t: TestContext) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
}

test("Windows legacy workspace keys keep title and flags when synchronized for desktop", t => {
  const { db } = fixture(t);
  windowsPlatform(t);
  const oldPath = "e:\\Projects\\项目", canonical = "E:\\Projects\\项目";
  db.prepare("INSERT INTO tasks (workspace_key, task_id, title, title_overridden, archived, pinned, mode, updated_at) VALUES (?, 'old', 'My title', 1, 1, 1, 'plan', 10)").run(oldPath);
  assert.deepEqual(listWorkspacePathVariants(canonical), [canonical, oldPath]);
  assert.deepEqual(loadOverriddenTitles(canonical), { old: "My title" });
  assert.deepEqual(loadTaskFlags(canonical), { archived: ["old"], deleted: [] });
  assert.ok(upsertDesktopTask({workspacePath: canonical, sessionId: "old", title: "Generated"}));
  const row = db.prepare("SELECT * FROM tasks WHERE workspace_key=? AND task_id='old'").get(oldPath);
  assert.equal(row.title, "My title"); assert.equal(row.archived, 1); assert.equal(row.pinned, 1); assert.equal(row.mode, "plan");
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks WHERE task_id='old'").get().n, 1);
  setTaskArchived(canonical, "old", false);
  assert.deepEqual(loadTaskFlags(oldPath), { archived: [], deleted: [] });
  assert.ok(upsertDesktopTask({workspacePath: canonical, sessionId: "old", title: "Renamed", overrideTitle: true}));
  assert.equal(db.prepare("SELECT title FROM tasks WHERE workspace_key=? AND task_id='old'").get(oldPath).title, "Renamed");
  setTaskDeleted(canonical, "old");
  assert.deepEqual(loadTaskFlags(oldPath), { archived: [], deleted: ["old"] });
  assert.ok(upsertDesktopTask({workspacePath: canonical, sessionId: "old", title: "Generated"}));
  assert.equal(db.prepare("SELECT deleted FROM tasks WHERE workspace_key=? AND task_id='old'").get(oldPath).deleted, 1);
});

test("Windows workspace variants include CLI-only paths and exclude other directories", t => {
  const { root } = fixture(t);
  const cli = path.join(root, ".zcode/cli/db/db.sqlite");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  const db = new DatabaseSync(cli);
  db.exec("CREATE TABLE session (directory TEXT)");
  db.prepare("INSERT INTO session VALUES (?)").run("e:/projects/项目/");
  db.prepare("INSERT INTO session VALUES (?)").run("E:\\Projects\\项目2");
  db.close();
  windowsPlatform(t);
  assert.deepEqual(listWorkspacePathVariants("E:\\Projects\\项目"), ["E:\\Projects\\项目", "e:/projects/项目/"]);
});

test("Linux desktop flags remain isolated between case-distinct directories", { skip: process.platform === "win32" }, t => {
  const { db } = fixture(t);
  db.exec("INSERT INTO tasks (workspace_key, task_id, deleted) VALUES ('/project/A', 'upper', 1), ('/project/a', 'lower', 1)");
  assert.deepEqual(loadTaskFlags("/project/A"), { archived: [], deleted: ["upper"] });
  assert.deepEqual(listWorkspacePathVariants("/project/A"), ["/project/A"]);
});

test("Windows listing queries both exact server paths, deduplicates IDs, and retains the legacy desktop key", async t => {
  const { db } = fixture(t);
  windowsPlatform(t);
  const canonical = "E:\\Projects\\项目", legacy = "e:\\Projects\\项目";
  db.prepare("INSERT INTO tasks (workspace_key, task_id, title) VALUES (?, 'plugin', 'Plugin chat')").run(legacy);
  const client = new ZCodeClient({binaryPath: "/unused", workspacePath: canonical, onEvent: () => {}});
  const requests: string[] = [];
  const state = client as unknown as {sendRequest: (method: string, params: {workspace: {workspacePath: string}; includeArchived: boolean}) => Promise<unknown>};
  state.sendRequest = async (method, params) => {
    assert.equal(method, "session/list"); assert.equal(params.includeArchived, true);
    const scope = params.workspace.workspacePath; requests.push(scope);
    // Model exact equality used by the real server (not an unfiltered fixture).
    const stored = [
      {sessionId: "desktop", workspace: {workspacePath: canonical}, updatedAt: 20},
      {sessionId: "plugin", workspace: {workspacePath: legacy}, updatedAt: 10},
    ];
    return {sessions: [...stored.filter(s => s.workspace.workspacePath === scope),
      {sessionId: "shared", workspace: {workspacePath: scope}, updatedAt: scope === canonical ? 1 : 30},
      {sessionId: "unrelated", workspace: {workspacePath: "E:\\Projects\\项目2"}},
    ]};
  };
  const sessions = await client.listSessions(true);
  assert.deepEqual(requests, [canonical, legacy]);
  assert.deepEqual(sessions.map(s => s.sessionId), ["shared", "desktop", "plugin"]);
  const provider = new ZCodeViewProvider({subscriptions: [], workspaceState: {get: () => undefined, update: async () => {}}, globalState: {get: () => undefined, update: async () => {}}} as unknown as vscode.ExtensionContext);
  const internal = provider as unknown as {workspacePath: string; client: ZCodeClient; refreshSessions: () => Promise<void>};
  internal.workspacePath = canonical; internal.client = client;
  await internal.refreshSessions();
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks WHERE workspace_key=? AND task_id='plugin'").get(legacy).n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks WHERE task_id='plugin'").get().n, 1);
});

test("copy diagnostics uses an allowlist and omits credentials, session IDs and raw errors", async t => {
  fixture(t);
  const clipboard = vscode.env.clipboard;
  const original = clipboard.writeText;
  let copied = "";
  clipboard.writeText = async value => {copied = value;};
  t.after(() => {clipboard.writeText = original;});
  const provider = new ZCodeViewProvider({subscriptions: [], extension: {packageJSON: {version: "1.3.6-local.test"}}} as unknown as vscode.ExtensionContext);
  const state = provider as unknown as {
    workspacePath: string; client: unknown;
    post: (msg: Record<string, unknown>) => void;
    copyDiagnostics: () => Promise<void>;
  };
  state.workspacePath = os.homedir() + "/项目";
  state.client = {diagnosticSummary: () => ({
    binaryPath: "/missing/zcode.cjs", nodePath: os.homedir() + "/node", serverReady: true,
    sessionAttached: true, synchronizationFailures: 1, pendingPermissions: 1, pendingQuestions: 0,
    apiKey: "SECRET_CREDENTIAL", sessionId: "PRIVATE_SESSION_ID", chat: "PRIVATE_CHAT_CONTENT",
  })};
  state.post({type: "session_error", message: "snapshot PRIVATE_CHAT_CONTENT apiKey=SECRET_CREDENTIAL"});
  await state.copyDiagnostics();
  assert.ok(!copied.includes("SECRET_CREDENTIAL") && !copied.includes("PRIVATE_SESSION_ID") && !copied.includes("PRIVATE_CHAT_CONTENT"));
  const report = JSON.parse(copied);
  assert.equal(report.extensionVersion, "1.3.6-local.test");
  assert.equal(report.workspace.effectivePath, "~/项目");
  assert.equal(report.runtime.pendingPermissions, 1);
  assert.equal(report.recentIssues[0].category, "synchronization");
});

test("CLI default preserves account provider identity and rejects malformed configuration", t => {
 const {root}=fixture(t);const file=path.join(root,".zcode/cli/config.json");fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file,JSON.stringify({model:"account:bigmodel-team-coding-plan/GLM-5.3-Flash",provider:{}}));
 assert.deepEqual(readCliDefaultModel(),{providerId:"account:bigmodel-team-coding-plan",modelId:"GLM-5.3-Flash"});
 for(const model of [null,{},"","provider/","/model","noslash"]){fs.writeFileSync(file,JSON.stringify({model}));assert.equal(readCliDefaultModel(),undefined);}
 fs.writeFileSync(file,"{");assert.equal(readCliDefaultModel(),undefined);
});

test("fresh install without CLI default resolves the active account registry provider",t=>{
 const {root}=fixture(t);const v2=path.join(root,".zcode/v2");
 fs.writeFileSync(path.join(v2,"setting.json"),JSON.stringify({providerFamilyDomain:"bigmodel",providerFamilyConnectionSelections:{bigmodel:{kind:"team-coding-plan"}}}));
 fs.writeFileSync(path.join(v2,"credentials.json"),JSON.stringify({"oauth:bigmodel:access_token":"FAKE-TEST-TOKEN"}));
 const rules=path.join(v2,"runtime/provider/test");fs.mkdirSync(rules,{recursive:true});
 fs.writeFileSync(path.join(rules,"zcode-builtin.json"),JSON.stringify({config:{providerConfigRules:{providerRules:[{providerId:"account:bigmodel-team-coding-plan",providerName:"Fixture team",config:{builtinModelIds:["GLM-5.3-Flash"],access:{type:"zhipu-account"}}}]}}}));
 const runtime:ResolvedRuntime={providerId:"builtin:bigmodel-coding-plan",providerName:"Legacy",modelId:"GLM-5.3-Flash",kind:"openai",baseURL:"http://localhost",apiKey:"TEST-ONLY",models:{},source:"desktop-team-oauth"};
 assert.deepEqual(readConfiguredDefaultModel(runtime),{providerId:"account:bigmodel-team-coding-plan",modelId:"GLM-5.3-Flash"});
 assert.deepEqual(readConfiguredDefaultModel({...runtime,modelId:"obsolete-login-default"}),{providerId:"account:bigmodel-team-coding-plan",modelId:"GLM-5.3-Flash"});
 fs.unlinkSync(path.join(v2,"credentials.json"));assert.equal(readConfiguredDefaultModel(runtime),undefined);
});

test("snapshots left by dead processes are removed on startup, everything else is kept", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-orphans-"));
  try {
    const dead = "zcode-sqlite-41-1700000000000-ab12.sqlite";
    const deadJournal = "zcode-sqlite-41-1700000000000-ab12.sqlite-journal";
    const live = "zcode-sqlite-42-1700000000000-cd34.sqlite";
    const mine = `zcode-sqlite-${process.pid}-1700000000000-ef56.sqlite`;
    const unrelated = ["zcode-sqlite-notes.txt", "other-41.sqlite", "zcode-sqlite-41-1-zz.sqlite"];
    for (const name of [dead, deadJournal, live, mine, ...unrelated]) fs.writeFileSync(path.join(dir, name), "x");
    fs.mkdirSync(path.join(dir, "zcode-sqlite-43-1700000000000-aa.sqlite"));
    fs.symlinkSync(path.join(dir, live), path.join(dir, "zcode-sqlite-44-1700000000000-bb.sqlite"));
    const removed = await cleanupOrphanedSqliteSnapshots(dir, pid => pid === 42);
    assert.equal(removed, 2);
    const left = fs.readdirSync(dir).sort();
    assert.deepEqual(left, [live, mine, "zcode-sqlite-43-1700000000000-aa.sqlite", "zcode-sqlite-44-1700000000000-bb.sqlite", ...unrelated].sort());
    assert.equal(await cleanupOrphanedSqliteSnapshots(path.join(dir, "missing")), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("short-lived plan tokens never enter CLI config or the app-server environment", t => {
  fixture(t);
  for (const providerId of ["builtin:zai-coding-plan", "account:zai-individual-coding-plan"]) {
    const runtime: ResolvedRuntime = {
      providerId, providerName: "Test", modelId: "test", models: {}, kind: "anthropic",
      baseURL: "https://example.invalid", apiKey: "TEST-SHORT-LIVED-TOKEN", apiKeyId: "TEST-KEY-ID",
      source: "desktop-personal-oauth",
    };
    const file = syncCliConfig({ ...runtime, apiKeyId: undefined }, { provider: {} });
    syncCliConfig(runtime, { provider: { [providerId]: { options: { apiKey: "TEST-STALE-KEY" } } } });
    const config = fs.readFileSync(file, "utf8");
    assert.equal(config.includes("TEST-SHORT-LIVED-TOKEN"), false);
    assert.equal(config.includes("TEST-STALE-KEY"), false);
    assert.deepEqual(runtimeEnv(runtime), {});
  }
});

function sessionOperations(t: TestContext) {
  const f = fixture(t);
  f.db.prepare("INSERT INTO tasks(workspace_key,task_id,title) VALUES('/project','A','original')").run();
  const cliPath = path.join(f.root, ".zcode/cli/db/db.sqlite");
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  const cli = new DatabaseSync(cliPath);
  cli.exec(`CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,title_source TEXT,version TEXT,
    directory TEXT,path TEXT,time_updated INTEGER,time_title_updated INTEGER,time_archived INTEGER);
    INSERT INTO session(id,title,version) VALUES('A','original','3.16.2');`);
  cli.close();
  const provider = new ZCodeViewProvider({ subscriptions: [],
    workspaceState: { get: () => undefined, update: async () => {} },
    globalState: { get: () => undefined, update: async () => {} },
  } as unknown as vscode.ExtensionContext);
  const posted: Array<{ type: string; text?: string; sessions?: Array<{ sessionId: string; title?: string }> }> = [];
  const state = provider as unknown as {
    workspacePath: string;
    sessions: Array<{ sessionId: string; title?: string }>;
    client: { currentSessionId: string; listSessions: () => Promise<Array<{sessionId: string; title?: string; archivedAt?: number}>> };
    post: (message: typeof posted[number]) => void;
    refreshSessions: (includeArchived?: boolean) => Promise<void>;
    applyRename: (id: string, title: string) => Promise<void>;
    archiveSession: (id: string, archived: boolean) => Promise<void>;
  };
  state.workspacePath = "/project";
  state.sessions = [{ sessionId: "A", title: "original" }];
  state.client = { currentSessionId: "other", listSessions: async () => [{sessionId: "A", title: "stale server title"}] };
  state.post = message => posted.push(message);
  return { ...f, state, posted, cliPath, index: path.join(f.root, ".zcode/v2/tasks-index.sqlite") };
}

test("failed session listing preserves displayed sessions and a later refresh recovers", async t => {
  const { state, posted } = sessionOperations(t);
  const existing = state.sessions;
  state.client.listSessions = async () => { throw new Error("desktop unavailable"); };
  await state.refreshSessions();
  assert.equal(state.sessions, existing);
  assert.ok(!posted.some(message => message.type === "sessions"), "failure replaced the list with empty results");
  state.client.listSessions = async () => [{ sessionId: "A", title: "recovered" }];
  await state.refreshSessions();
  assert.equal(state.sessions[0].title, "recovered");
  assert.equal(posted.filter(message => message.type === "sessions").length, 1);
});

test("rename and archive persist after reopening storage and override stale server lists", async t => {
  const { state, posted, index, cliPath } = sessionOperations(t);
  await state.applyRename("A", "My saved title");
  const reopenedCli = new DatabaseSync(cliPath);
  try {
    assert.deepEqual({ ...reopenedCli.prepare("SELECT title,title_source FROM session WHERE id='A'").get() },
      { title: "My saved title", title_source: "custom" });
  } finally { reopenedCli.close(); }
  await state.archiveSession("A", true);
  const reopened = new DatabaseSync(index);
  try {
    assert.deepEqual({ ...reopened.prepare("SELECT title,title_overridden,archived FROM tasks WHERE task_id='A'").get() },
      { title: "My saved title", title_overridden: 1, archived: 1 });
  } finally { reopened.close(); }
  await state.refreshSessions(true);
  assert.deepEqual(state.sessions.map(s => [s.sessionId, s.title]), [["A", "My saved title"]]);
  await state.archiveSession("A", false);
  assert.equal(state.sessions.length, 0, "a restored session must leave the archived tab");
  await state.refreshSessions(false);
  assert.deepEqual(state.sessions.map(s => [s.sessionId, s.title]), [["A", "My saved title"]]);
  assert.ok(!posted.some(message => /同步失败|未能完成/.test(message.text || "")));
  assert.ok(!posted.some(message => message.type === "session_error"));
});

test("restoring a session survives stale archived server lists and reopening the index", async t => {
  const { state, index } = sessionOperations(t);
  await state.archiveSession("A", true);
  state.client.listSessions = async () => [{ sessionId: "A", title: "original", archivedAt: 100 }];
  await state.archiveSession("A", false);
  assert.equal(state.sessions.length, 0, "restored session must leave the archived tab");
  assert.equal(upsertDesktopTask({ workspacePath: "/project", sessionId: "A", title: "original", archived: true }), true,
    "indexing a cached archive must honor the restored CLI state");
  for (let attempt = 0; attempt < 2; attempt++) {
    await state.refreshSessions(false);
    assert.deepEqual(state.sessions.map(s => s.sessionId), ["A"]);
    const reopened = new DatabaseSync(index);
    try { assert.equal(reopened.prepare("SELECT archived FROM tasks WHERE task_id='A'").get().archived, 0); }
    finally { reopened.close(); }
  }
  state.client.listSessions = async () => [{ sessionId: "A", title: "original" }];
  await state.refreshSessions(false);
  assert.deepEqual(state.sessions.map(s => s.sessionId), ["A"]);
});

for (const action of ["rename", "archive"] as const) {
  test(`${action} under a real database write lock reports failure and leaves saved state unchanged`, async t => {
    const { state, posted, db, cliPath } = sessionOperations(t);
    const locker = action === "rename" ? new DatabaseSync(cliPath) : db;
    locker.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE");
    try {
      if (action === "rename") await state.applyRename("A", "must not save");
      else await state.archiveSession("A", true);
      assert.deepEqual({ ...db.prepare("SELECT title,archived FROM tasks WHERE task_id='A'").get() },
        { title: "original", archived: 0 });
      assert.equal(posted.length, 1);
      assert.equal(posted[0].type, "toast");
      assert.match(posted[0].text!, /未能完成/);
      assert.ok(!posted.some(message => message.type === "session_title" || message.type === "session_error"));
    } finally { locker.exec("ROLLBACK"); if (locker !== db) locker.close(); }
    // The same user action must work once the desktop releases its lock.
    if (action === "rename") await state.applyRename("A", "retry saved");
    else await state.archiveSession("A", true);
    assert.equal(db.prepare(action === "rename" ? "SELECT title AS value FROM tasks WHERE task_id='A'" :
      "SELECT archived AS value FROM tasks WHERE task_id='A'").get().value, action === "rename" ? "retry saved" : 1);
  });
}

for (const action of ["rename", "archive"] as const) {
  test(`${action} reports a partial save when the second database fails and retry finishes synchronization`, async t => {
    const { state, posted, db, cliPath } = sessionOperations(t);
    const cli = new DatabaseSync(cliPath);
    try {
      const failing = action === "rename" ? db : cli;
      failing.exec(`CREATE TRIGGER fail_sync BEFORE UPDATE ON ${action === "rename" ? "tasks" : "session"}
        BEGIN SELECT RAISE(ABORT,'test second database failure'); END`);
      const attempt = () => action === "rename" ? state.applyRename("A", "Saved name") : state.archiveSession("A", true);
      await attempt();
      assert.equal(posted.length, 1);
      assert.equal(posted[0].type, "toast");
      assert.match(posted[0].text!, /已保存.*同步失败.*重试/);
      assert.ok(!posted.some(message => message.type === "session_error" || message.type === "session_title"));
      if (action === "rename") {
        assert.equal(cli.prepare("SELECT title FROM session WHERE id='A'").get().title, "Saved name");
        assert.equal(db.prepare("SELECT title FROM tasks WHERE task_id='A'").get().title, "original");
      } else {
        assert.equal(db.prepare("SELECT archived FROM tasks WHERE task_id='A'").get().archived, 1);
        assert.equal(cli.prepare("SELECT time_archived FROM session WHERE id='A'").get().time_archived, null);
      }
      failing.exec("DROP TRIGGER fail_sync");
      posted.length = 0;
      await attempt();
      if (action === "rename") {
        assert.equal(cli.prepare("SELECT title FROM session WHERE id='A'").get().title, "Saved name");
        assert.equal(db.prepare("SELECT title FROM tasks WHERE task_id='A'").get().title, "Saved name");
      } else {
        assert.equal(db.prepare("SELECT archived FROM tasks WHERE task_id='A'").get().archived, 1);
        assert.ok(cli.prepare("SELECT time_archived FROM session WHERE id='A'").get().time_archived);
      }
      assert.ok(!posted.some(message => /同步失败/.test(message.text || "")));
      assert.equal(db.prepare("SELECT count(*) AS n FROM tasks WHERE task_id='A'").get().n, 1);
    } finally { cli.close(); }
  });
}

test("Windows rename keeps both the CLI directory spelling and existing desktop key", async t => {
  const { state, db, cliPath } = sessionOperations(t);
  windowsPlatform(t);
  const original = "e:/Work/Repo", canonical = "E:\\work\\repo";
  state.workspacePath = canonical;
  db.prepare("UPDATE tasks SET workspace_key=?,workspace_path=? WHERE task_id='A'").run(original, original);
  const cli = new DatabaseSync(cliPath);
  try {
    cli.prepare("UPDATE session SET directory=?,path=? WHERE id='A'").run(original, original);
    await state.applyRename("A", "Saved name");
    assert.equal(cli.prepare("SELECT directory FROM session WHERE id='A'").get().directory, original);
    assert.equal(db.prepare("SELECT workspace_key FROM tasks WHERE task_id='A'").get().workspace_key, original);
    assert.equal(db.prepare("SELECT title FROM tasks WHERE task_id='A'").get().title, "Saved name");
    assert.equal(db.prepare("SELECT count(*) AS n FROM tasks WHERE task_id='A'").get().n, 1);
  } finally { cli.close(); }
});
