import assert from "node:assert/strict";
import { ChildProcess } from "child_process";
import test, { type TestContext } from "node:test";
import * as fs from "fs";
import * as path from "path";
import { ZCodeClient, type ZCodeEvent, type HistoryItem, type PermissionRequest, type UserInputRequest, type SessionControls } from "./zcodeClient";
import type { ResolvedRuntime } from "./desktop";
import { ConversationReplica } from "./conversation";
import { handoffScenario } from "./testSupport/handoffScenario";
import { workbarBackendSnapshot } from "./testSupport/workbarBackendFixture";
import type { NewSessionDefaults } from "./newSessionDefaults";

interface Internals {
  applySnapshotSettings: (snapshot: unknown) => void;
  adoptControlsFromPatch: (patch: Record<string,unknown>) => void;
  sessionId: string | null;
  sessionGeneration: number;
  lastControls: SessionControls;
  lastContext: { used: number; max: number } | null;
  sessionModel: { providerId: string; modelId: string } | null;
  lastQuota: Array<Record<string, unknown>>;
  lastQuotaProviderId: string | undefined;
  lastPlanQuota: Array<Record<string, unknown>>;
  refreshPlanQuota: () => Promise<void>;
  lastRevision: number;
  liveModelReady: boolean;
  lastLogEpoch: string;
  conversationRevision: number | null;
  stopping: boolean;
  alignAndEmitModel: (model: { providerId: string; modelId: string }) => Promise<void>;
  sessionRuntime: unknown;
  runtimeNeedsRevalidation: boolean;
  historyCache: { sessionId: string; items: HistoryItem[] } | null;
  pendingPermissions: Map<string, PermissionRequest>;
  pendingUserInputs: Map<string, UserInputRequest>;
  sendRequest: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  write: (message: unknown) => void;
  afterSessionAttached: () => Promise<void>;
  adoptResumedModel: () => Promise<void>;
  ensureSessionModel: (snapshot?: unknown) => Promise<void>;
  handleSessionEvent: (event: unknown) => void;
  handleConversationFrame: (event: unknown) => void;
  handleStateUpdated: (event: unknown) => void;
  subscribeConversation: () => Promise<void>;
  createSession: (applyModel: boolean) => Promise<void>;
  applyNewSessionDefaults: (defaults: NewSessionDefaults) => Promise<void>;
  setModel: (providerId: string, modelId: string) => Promise<void>;
  openStartupSession: (opts?: {
    chooseResume?: (listed: import("./zcodeClient").SessionSummary[], rejected: ReadonlySet<string>) => string | undefined;
  }) => Promise<void>;
}

function fixture(
  defaultModel?: {providerId:string;modelId:string},
  resolveSessionRuntime?: (model: {providerId:string;modelId:string}) => Promise<ResolvedRuntime | null | false>
) {
  const events: ZCodeEvent[] = [];
  const client = new ZCodeClient({ binaryPath: "/unused", workspacePath: "/test", readDefaultModel: () => defaultModel, resolveSessionRuntime, onEvent: (e) => events.push(e) });
  const state = client as unknown as Internals;
  state.sessionId = "A";
  return { client, state, events };
}

function isolatedHome(t: TestContext): string {
  const os = require("os") as typeof import("os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-client-test-"));
  const originalHome = os.homedir;
  os.homedir = () => root;
  t.after(() => { os.homedir = originalHome; fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}

test("a late skill catalog response does not replace a newer refresh", async () => {
  const { client, state, events } = fixture();
  const requests: Array<(value: unknown) => void> = [];
  state.sendRequest = async () => new Promise(resolve => requests.push(resolve));
  try {
    client.refreshSkillCatalog();
    client.refreshSkillCatalog();
    requests[1]({ skills: [{ name: "new", description: "", path: "/new/SKILL.md" }] });
    await new Promise(resolve => setImmediate(resolve));
    requests[0]({ skills: [{ name: "old", description: "", path: "/old/SKILL.md" }] });
    await new Promise(resolve => setImmediate(resolve));
    const catalogs = events.filter(event => event.type === "skill_catalog");
    assert.equal(catalogs.length, 1);
    assert.equal((catalogs[0].data as { skills: Array<{ name: string }> }).skills[0].name, "new");
  } finally { client.dispose(); }
});

test("subagent suggestions use the active session plugin catalog", { timeout: 3000 }, async () => {
  let publish!: (event: ZCodeEvent) => void;
  const complete = new Promise<ZCodeEvent>(resolve => { publish = resolve; });
  const client = new ZCodeClient({ binaryPath: "/unused", workspacePath: "/test", onEvent: event => {
    const data = event.data as { agents?: Array<{ name: string }> };
    if (event.type === "subagent_catalog" && data.agents?.some(agent => agent.name === "demo:reviewer")) publish(event);
  } });
  const state = client as unknown as Internals;
  state.sessionId = "A";
  state.sendRequest = async (method, params) => {
    assert.equal(method, "plugins/referenceCatalog");
    assert.equal((params as { sessionId: string }).sessionId, "A");
    return { plugins: [{ enabled: true, subagentNames: ["demo:reviewer"] }] };
  };
  client.refreshSubagentCatalog();
  const event = await complete;
  const data = event.data as { sessionId: string; agents: Array<{ name: string }> };
  assert.equal(data.sessionId, "A");
  assert.ok(data.agents.some(agent => agent.name === "reviewer"));
  assert.ok(data.agents.some(agent => agent.name === "Explore"));
  client.dispose();
});

test("an explicitly disabled session model cannot fall back to a stale CLI provider key", async t => {
  const root = isolatedHome(t);
  const configDir = path.join(root, ".zcode", "v2");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ provider: {
    "deleted-provider": {
      name: "Deleted provider",
      kind: "openai-compatible",
      options: { apiKey: "TEST-ONLY-STALE-KEY", baseURL: "https://example.test/v1" },
      models: { "old-model": {} },
    },
  } }));

  const activeRuntime: ResolvedRuntime = {
    providerId: "active-provider", providerName: "Active provider", kind: "openai-compatible",
    baseURL: "https://example.test/v1", apiKey: "TEST-ONLY-ACTIVE-KEY", modelId: "active-model",
    models: {}, source: "custom-provider",
  };
  const client = new ZCodeClient({
    binaryPath: "/unused", workspacePath: "/test", runtime: activeRuntime,
    resolveSessionRuntime: async () => false,
    onEvent: () => undefined,
  });
  const state = client as unknown as Internals;
  state.sessionId = "A";
  try {
    await state.alignAndEmitModel({ providerId: "deleted-provider", modelId: "old-model" });
    assert.equal(state.sessionRuntime, null);
  } finally { client.dispose(); }
});

test("resuming a session revalidates a cached provider login before reuse", async () => {
  let resolutions = 0;
  const runtime: ResolvedRuntime = { providerId: "sampleVendor", providerName: "Sample vendor", modelId: "glm", kind: "openai-compatible", baseURL: "https://example.test/v1", apiKey: "TEST-ONLY-STALE", models: {}, source: "custom-provider" };
  const client = new ZCodeClient({ binaryPath: "/unused", workspacePath: "/test", runtime,
    resolveSessionRuntime: async () => { resolutions++; return false; }, onEvent: () => undefined });
  const state = client as unknown as Internals;
  state.sessionId = "B";
  state.runtimeNeedsRevalidation = true;
  try {
    await state.alignAndEmitModel({ providerId: "sampleVendor", modelId: "glm" });
    assert.equal(resolutions, 1);
    assert.equal(state.sessionRuntime, null, "cached API key revived a desktop-disabled provider");
  } finally { client.dispose(); }
});

test("unavailable new-session defaults skip model switching and model-specific reasoning", async () => {
  const { client, state, events } = fixture(undefined, async () => false);
  let modelCalls = 0;
  state.setModel = async () => { modelCalls++; };
  try {
    await state.applyNewSessionDefaults({
      model: { providerId: "deleted-provider", modelId: "old-model" },
      thoughtLevel: "high",
    });
    assert.equal(modelCalls, 0);
    assert.equal(events.some(event => event.type === "session_defaults_warning"
      && (event.data as { message?: string }).message === "新会话默认模型当前不可用，已沿用 ZCode 默认模型。"), true);
    assert.equal(events.some(event => event.type === "session_defaults_warning"
      && (event.data as { message?: string }).message === "所选模型不支持该推理强度，已使用模型默认值。"), false);
  } finally { client.dispose(); }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("quota refresh runs only while the chat view is visible", () => {
  const { client } = fixture();
  const state = client as unknown as {
    startPlanQuota: () => void;
    refreshPlanQuota: () => Promise<void>;
    quotaTimer: NodeJS.Timeout | null;
  };
  let refreshes = 0;
  state.refreshPlanQuota = async () => { refreshes++; };
  client.setViewVisible(false);
  state.startPlanQuota();
  assert.equal(refreshes, 0);
  assert.equal(state.quotaTimer, null);
  client.setViewVisible(true);
  assert.equal(refreshes, 1);
  assert.ok(state.quotaTimer);
  client.setViewVisible(false);
  assert.equal(state.quotaTimer, null);
  client.setViewVisible(true);
  assert.equal(refreshes, 2);
  client.dispose();
  assert.equal(state.quotaTimer, null);
});

test("built-in provider adapters use the generic quota path and fall back to ZCode quota", async () => {
  const plan = { family: "bigmodel" as const, kind: "individual-coding-plan" as const, providerId: "builtin:bigmodel-coding-plan" };
  const planQuota = [{ label: "5 小时", remainingPercent: 75, usedPercent: 25 }];
  let adapterResult: Array<{ label: string; remainingAmount: number; currency: "CNY" | "USD" }> | null = [
    { label: "CNY", remainingAmount: 42.5, currency: "CNY" },
  ];
  let failAdapter = false;
  let adapterCalls: string[] = [];
  let planCalls = 0;
  const events: ZCodeEvent[] = [];
  const client = new ZCodeClient({
    binaryPath: "/unused",
    workspacePath: "/test",
    readQuotaPlan: () => plan,
    fetchProviderQuota: async providerId => {
      adapterCalls.push(providerId);
      if (failAdapter) throw new Error("simulated balance failure");
      return adapterResult;
    },
    fetchPlanQuota: async () => { planCalls++; return planQuota; },
    onEvent: event => events.push(event),
  });
  const state = client as unknown as Internals;
  state.sessionId = "A";
  state.sessionModel = { providerId: "deepseek", modelId: "deepseek-chat" };

  await state.refreshPlanQuota();
  assert.deepEqual(adapterCalls, ["deepseek"]);
  assert.equal(planCalls, 0, "successful built-in adapter should not make a plan request");
  assert.deepEqual((events.at(-1)?.data as { quota: unknown[] }).quota, [
    { label: "CNY", remainingAmount: 42.5, currency: "CNY" },
  ]);

  adapterResult = null;
  await state.refreshPlanQuota();
  assert.equal(planCalls, 1, "unsupported adapter response did not use the existing plan quota");
  assert.deepEqual((events.at(-1)?.data as { quota: unknown[] }).quota, planQuota);

  failAdapter = true;
  await state.refreshPlanQuota();
  assert.equal(planCalls, 2, "failed adapter request did not fall back to the existing plan quota");
  assert.deepEqual((events.at(-1)?.data as { quota: unknown[] }).quota, planQuota);

  state.sessionModel = { providerId: "other-provider", modelId: "custom" };
  const priorAdapterCallCount = adapterCalls.length;
  await state.refreshPlanQuota();
  assert.equal(adapterCalls.length, priorAdapterCallCount + 1, "every provider checks the generic adapter registry");
  assert.equal(adapterCalls.at(-1), "other-provider");
  assert.equal(planCalls, 3);
  client.dispose();
});

test("a late provider adapter result cannot overwrite quota after switching models", async () => {
  const pending = deferred<Array<{ label: string; remainingAmount: number; currency: "CNY" | "USD" }> | null>();
  const events: ZCodeEvent[] = [];
  const client = new ZCodeClient({
    binaryPath: "/unused",
    workspacePath: "/test",
    readQuotaPlan: () => ({ family: "bigmodel", kind: "individual-coding-plan", providerId: "builtin:bigmodel-coding-plan" }),
    fetchProviderQuota: providerId => providerId === "deepseek" ? pending.promise : Promise.resolve(null),
    fetchPlanQuota: async () => [{ label: "Week", remainingPercent: 80, usedPercent: 20 }],
    onEvent: event => events.push(event),
  });
  const state = client as unknown as Internals;
  state.sessionId = "A";
  state.sessionModel = { providerId: "deepseek", modelId: "deepseek-chat" };
  const stale = state.refreshPlanQuota();
  state.sessionModel = { providerId: "bigmodel-coding-plan", modelId: "glm" };
  await state.refreshPlanQuota();
  pending.resolve([{ label: "USD", remainingAmount: 999, currency: "USD" }]);
  await stale;
  assert.deepEqual((events.at(-1)?.data as { quota: unknown[] }).quota, [
    { label: "Week", remainingPercent: 80, usedPercent: 20 },
  ]);
  client.dispose();
});

test("cached provider quota is hidden immediately after switching providers", async t => {
  for (const hasModelContext of [false, true]) {
    await t.test(hasModelContext ? "with model context metadata" : "without model context metadata", async t => {
      const root = isolatedHome(t);
      const configDir = path.join(root, ".zcode", "v2");
      fs.mkdirSync(configDir, { recursive: true });
      const targetModel = { providerId: "moonshot-kimi", modelId: "quota-test-model" };
      fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ provider: {
        [targetModel.providerId]: { models: {
          [targetModel.modelId]: hasModelContext ? { limit: { context: 64000 } } : {},
        } },
      } }));
      const pending = deferred<Array<{ label: string; remainingAmount: number; currency: "CNY" | "USD" }> | null>();
      const planQuota = [{ label: "ZCode Plan", remainingPercent: 70, usedPercent: 30 }];
      const events: ZCodeEvent[] = [];
      const client = new ZCodeClient({
        binaryPath: "/unused",
        workspacePath: "/test",
        readQuotaPlan: () => ({ family: "bigmodel", kind: "individual-coding-plan", providerId: "builtin:bigmodel-coding-plan" }),
        fetchProviderQuota: providerId => providerId === "deepseek" ? pending.promise : Promise.resolve(null),
        fetchPlanQuota: async () => planQuota,
        onEvent: event => events.push(event),
      });
      const state = client as unknown as Internals;
      t.after(() => client.dispose());
      state.sessionId = "A";
      state.sessionModel = { providerId: "deepseek", modelId: "deepseek-chat" };
      state.lastQuota = [{ label: "DeepSeek", remainingAmount: 12, currency: "CNY" }];
      state.lastQuotaProviderId = "deepseek";
      state.lastPlanQuota = planQuota;

      const oldRequest = state.refreshPlanQuota();
      await state.alignAndEmitModel(targetModel);
      const usage = () => events.filter(event => event.type === "context_usage").at(-1)?.data as {
        quota: unknown[]; max?: number;
      } | undefined;
      assert.deepEqual(usage()?.quota, planQuota,
        "switch published DeepSeek's cached balance for Kimi");
      assert.ok(events.some(event => event.type === "model_info"));
      if (hasModelContext) assert.equal(usage()?.max, 64000);

      state.applySnapshotSettings(undefined);
      assert.deepEqual(usage()?.quota, planQuota,
        "a later usage snapshot republished the previous provider's quota");
      pending.resolve([{ label: "Late DeepSeek", remainingAmount: 999, currency: "USD" }]);
      await oldRequest;
      assert.deepEqual(usage()?.quota, planQuota,
        "an old provider request overwrote the ZCode fallback after switching");
    });
  }
});

test("configured provider quota is used by exact provider id and falls back to ZCode quota", async () => {
  const plan = { family: "bigmodel" as const, kind: "individual-coding-plan" as const, providerId: "builtin:bigmodel-coding-plan" };
  const planQuota = [{ label: "5 小时", remainingPercent: 75, usedPercent: 25 }];
  const configuredQuota = [{ label: "余额", remainingAmount: 8.5, currency: "EUR" }];
  const events: ZCodeEvent[] = [];
  let customResult: typeof configuredQuota | null = configuredQuota;
  let customCalls: string[] = [];
  let planCalls = 0;
  const client = new ZCodeClient({
    binaryPath: "/unused",
    workspacePath: "/test",
    readQuotaPlan: () => plan,
    fetchProviderQuota: async providerId => { customCalls.push(providerId); return customResult; },
    fetchPlanQuota: async () => { planCalls++; return planQuota; },
    onEvent: event => events.push(event),
  });
  const state = client as unknown as Internals;
  state.sessionId = "A";
  state.sessionModel = { providerId: "private-provider", modelId: "model-x" };

  await state.refreshPlanQuota();
  assert.deepEqual(customCalls, ["private-provider"]);
  assert.equal(planCalls, 0);
  assert.deepEqual((events.at(-1)?.data as { quota: unknown[] }).quota, configuredQuota);

  customResult = null;
  await state.refreshPlanQuota();
  assert.equal(planCalls, 1);
  assert.deepEqual((events.at(-1)?.data as { quota: unknown[] }).quota, planQuota);

  state.sessionModel = { providerId: "another-provider", modelId: "model-y" };
  await state.refreshPlanQuota();
  assert.deepEqual(customCalls, ["private-provider", "private-provider", "another-provider"]);
  assert.equal(planCalls, 2);
  client.dispose();
});

test("startup waits once for a cold plugin scan and does not queue another resume", async () => {
  const { client, state } = fixture();
  const resumed: string[] = [];
  const timeouts: number[] = [];
  client.listSessions = async () => [
    { sessionId: "REMEMBERED", title: "remembered", updatedAt: 3 },
    { sessionId: "OTHER", title: "other", updatedAt: 2 },
  ];
  client.resumeSession = async (id: string, _known?: unknown, timeoutMs = 30000) => {
    resumed.push(id);
    timeouts.push(timeoutMs);
    if (id === "REMEMBERED") throw new Error(`Request session/resume timed out after ${timeoutMs}ms`);
    state.sessionId = id;
  };
  await state.openStartupSession({
    chooseResume: (listed, rejected) => rejected.has("REMEMBERED")
      ? listed.find((session) => session.sessionId === "OTHER")?.sessionId
      : "REMEMBERED",
  });
  assert.deepEqual(resumed, ["REMEMBERED", "OTHER"]);
  assert.deepEqual(timeouts, [90000, 90000]);
  assert.equal(state.sessionId, "OTHER");
});

test("a session list waits out an in-flight resume before using its normal deadline", async () => {
  const { client, state } = fixture();
  const resume = deferred<unknown>();
  const methods: string[] = [];
  const timeouts: number[] = [];
  state.afterSessionAttached = async () => {};
  state.adoptResumedModel = async () => {};
  state.sendRequest = async (method, _params, timeoutMs) => {
    methods.push(method);
    if (method === "session/list") timeouts.push(timeoutMs ?? 0);
    if (method === "session/resume") return resume.promise;
    return { sessions: [] };
  };
  const restoring = client.resumeSession("B", { sessionId: "B", title: "B", updatedAt: 1 });
  for (let i = 0; i < 20 && !methods.includes("session/resume"); i++) await tick();
  await client.listSessions();
  assert.deepEqual(timeouts, [90000]);
  resume.resolve({});
  await restoring;
  timeouts.length = 0;
  await client.listSessions();
  assert.deepEqual(timeouts, [20000]);
  client.dispose();
});

test("a timed-out resume keeps later session lists waiting until the server replies", async () => {
  const client = new ZCodeClient({ binaryPath: "/unused", workspacePath: "/test", onEvent: () => {} });
  const state = client as unknown as {
    write: (msg: { id: number; method: string; params?: { timeout?: number } }) => void;
    sendRequest: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
    handleLine: (line: string) => void;
  };
  const written: Array<{ id: number; method: string }> = [];
  const listTimeouts: number[] = [];
  const sendRequest = state.sendRequest.bind(client);
  state.write = (msg) => { written.push(msg); };
  try {
    await assert.rejects(sendRequest("session/resume", { sessionId: "A" }, 5), /timed out after 5ms/);
    state.sendRequest = async (method, _params, timeoutMs) => {
      if (method === "session/list") listTimeouts.push(timeoutMs ?? 0);
      return { sessions: [] };
    };
    await client.listSessions();
    // A late reply for the abandoned id means the server queue has moved on.
    state.handleLine(JSON.stringify({ id: written[0].id, result: {} }));
    await client.listSessions();
    assert.deepEqual(listTimeouts, [90000, 20000]);
  } finally {
    client.dispose();
  }
});

test("a read during resume does not query a session the server has not activated", async () => {
  const { client, state } = fixture();
  const resume = deferred<unknown>();
  const methods: string[] = [];
  state.afterSessionAttached = async () => {};
  state.adoptResumedModel = async () => {};
  state.sendRequest = async (method) => {
    methods.push(method);
    if (method === "session/resume") return resume.promise;
    if (method === "session/list") return { sessions: [] };
    return {};
  };
  const switching = client.switchSession("B");
  for (let i = 0; i < 10 && !methods.includes("session/resume"); i++) await tick();
  await client.emitSessionControls();
  assert.equal(methods.includes("session/read"), false);
  resume.resolve({});
  await switching;
  methods.length = 0;
  state.sendRequest = async (method) => {
    methods.push(method);
    return {
      session: { model: { providerId: "p", modelId: "m" } },
      settings: { mode: { current: "build" }, permission: { mode: "build" }, thoughtLevel: { enabled: false } },
    };
  };
  await client.emitSessionControls();
  assert.ok(methods.includes("session/read"));
});

test("startup follows the filtered choice and does not resume a stale first row", async () => {
  const { client, state } = fixture();
  const resumed: string[] = [];
  let created = 0;
  client.listSessions = async () => [
    { sessionId: "STALE", title: "stale", updatedAt: 3 },
    { sessionId: "VALID", title: "valid", updatedAt: 2 },
  ];
  client.resumeSession = async (id: string) => {
    resumed.push(id);
    if (id === "REMEMBERED") throw new Error("missing");
    state.sessionId = id;
  };
  state.createSession = async () => { created++; state.sessionId = "NEW"; };
  await state.openStartupSession({
    chooseResume: (listed, rejected) => rejected.has("REMEMBERED")
      ? listed.find((s) => s.sessionId === "VALID")?.sessionId
      : "REMEMBERED",
  });
  assert.deepEqual(resumed, ["REMEMBERED", "VALID"]);
  assert.equal(created, 0);

  resumed.length = 0;
  created = 0;
  await state.openStartupSession({ chooseResume: () => undefined });
  assert.deepEqual(resumed, []);
  assert.equal(created, 1);
  assert.equal(state.sessionId, "NEW");
});

test("rapid switches are serialized and the last requested session wins", async () => {
  const { client, state } = fixture();
  const firstResume = deferred<unknown>();
  const resumed: string[] = [];
  state.afterSessionAttached = async () => {};
  state.adoptResumedModel = async () => {};
  state.sendRequest = async (method, params) => {
    if (method === "session/list") return { sessions: [] };
    if (method === "session/resume") {
      const id = (params as { sessionId: string }).sessionId;
      resumed.push(id);
      return id === "A" ? firstResume.promise : {};
    }
    return { messages: [] };
  };
  const a = client.switchSession("A");
  const b = client.switchSession("B");
  await tick();
  assert.deepEqual(resumed, ["A"]);
  firstResume.resolve({});
  await Promise.all([a, b]);
  assert.deepEqual(resumed, ["A", "B"]);
  assert.equal(client.currentSessionId, "B");
});

test("immediate switch waits for the original session's send admission, not model output", async () => {
  const { client, state } = fixture();
  const modelReady = deferred<void>();
  const accepted = deferred<unknown>();
  const requests: Array<{ method: string; sessionId?: string }> = [];
  state.ensureSessionModel = () => modelReady.promise;
  state.afterSessionAttached = async () => {};
  state.adoptResumedModel = async () => {};
  state.sendRequest = async (method, params) => {
    const sessionId = (params as { sessionId?: string } | undefined)?.sessionId;
    requests.push({ method, sessionId });
    if (method === "session/send") return accepted.promise;
    return { sessions: [], messages: [] };
  };
  const sending = client.sendMessage("发送后立即切走");
  await tick();
  await client.prepareViewChange();
  const switching = client.switchSession("B");
  await tick();
  assert.equal(requests.length, 0);
  modelReady.resolve();
  await tick();
  assert.deepEqual(requests, [{ method: "session/send", sessionId: "A" }]);
  accepted.resolve({ accepted: true });
  await Promise.all([sending, switching]);
  assert.equal(client.currentSessionId, "B");
  assert.ok(requests.some(request => request.method === "session/resume" && request.sessionId === "B"));
  assert.equal(requests.filter(request => request.method === "session/stop").length, 0);
});

test("stopped snapshot before first token clears stale activity and rejects late legacy running status", async () => {
  const { client, state, events } = fixture();
  state.handleSessionEvent({ sessionId: "A", type: "turn.started" });
  assert.ok(client.activitySince("A"));
  state.sendRequest = async () => {
    state.handleConversationFrame({ topic: "conversation/A", subscriptionId: "stopped", fromSeq: 0, toSeq: 5,
      payload: { kind: "snapshot", snapshot: { logEpoch: "epoch", seq: 5,
        control: { phase: "completedInterrupted", canStop: false }, rows: { window: [
          { rowId: 1, kind: "turnHeader", turnId: "turn", state: "running" },
          { rowId: 2, kind: "userInput", turnId: "turn", text: "问题已发出" },
        ] },
      } } });
    return { ack: { subscriptionId: "stopped" } };
  };
  try {
    await client.prepareViewChange();
    await state.subscribeConversation();
    assert.equal(client.activitySince("A"), undefined);
    client.endViewChange();
    assert.equal((events.filter(event => event.type === "status").at(-1)?.data as { status: string }).status, "completedInterrupted");
    const count = events.length;
    state.handleSessionEvent({ sessionId: "A", type: "turn.started" });
    state.handleStateUpdated({ sessionId: "B", patch: { rows: { window: [{ rowId: 100, kind: "turnHeader", state: "running" }] } } });
    state.handleStateUpdated({ sessionId: "A", patch: { rows: { window: [{ rowId: 101, kind: "turnHeader", state: "running" }] } } });
    assert.equal(events.slice(count).filter(event => event.type === "status").length, 0);
    assert.equal(client.activitySince("A"), undefined);
  } finally { client.dispose(); }
});

test("real subscription ordering and repeated handoffs preserve both blocks and background text", async () => {
  const reasoning = "完整前缀。\n" + "切换期间的中间句。\n".repeat(400) + "正确结尾。";
  const scenario = await handoffScenario(reasoning);
  const history = scenario.messages.filter(message => message.type === "history").at(-1)!;
  const items = history.items as HistoryItem[];
  assert.equal(items[0].work?.text, "Earlier reasoning stays intact.");
  assert.equal(items[2].work?.text, reasoning);
  assert.equal(items[3].text, scenario.answer);
  assert.equal(items.length, 4);
});

test("gap recovery requests a forced snapshot and ignores subsequent legacy text", async () => {
  const { client, state, events } = fixture();
  const snapshot = (seq: number, text: string) => ({ topic: "conversation/A", subscriptionId: "sub", fromSeq: 0, toSeq: seq,
    payload: { kind: "snapshot", snapshot: { logEpoch: "epoch", seq, rows: {
      window: [{ rowId: 2, kind: "reasoning", text, state: "streaming" }], totalCount: 1,
    } } } });
  let resyncs = 0;
  state.sendRequest = async (method, params) => {
    if (method === "v4/conversation/subscribe") {
      state.handleConversationFrame(snapshot(5, "正确前缀。"));
      return { ack: { subscriptionId: "sub" } };
    }
    if (method === "v4/conversation/resync") {
      resyncs++;
      assert.deepEqual(params, { topic: "conversation/A", subscriptionId: "sub", connectionId: "zcode-vscode",
        base: { logEpoch: "epoch", seq: 5 }, forceSnapshot: true });
      state.handleConversationFrame(snapshot(9, "正确前缀。恢复中间句。"));
      return {};
    }
    throw new Error(`Unexpected RPC: ${method}`);
  };
  try {
    await client.prepareViewChange();
    await state.subscribeConversation();
    client.endViewChange();
    state.handleConversationFrame({ topic: "conversation/A", subscriptionId: "sub", fromSeq: 7, toSeq: 9,
      payload: { kind: "deltas", deltas: [{ op: "row.delta", rowId: 2, path: "text", append: "不能直接拼接" }] } });
    await tick();
    assert.equal(resyncs, 1);
    state.handleSessionEvent({ sessionId: "A", type: "model.streaming",
      payload: { kind: "reasoning_delta", delta: "旧通道重复文字" } });
    const history = await client.loadHistory();
    assert.equal(history.items[0].work?.text, "正确前缀。恢复中间句。");
    assert.ok(events.some(event => event.type === "transcript_sync"));
    assert.equal(events.filter(event => event.type === "assistant_reasoning_delta").length, 0);
  } finally { client.dispose(); }
});

test("projection pagination retains user message identity and loads through older questions", async () => {
  const { client, state } = fixture();
  const beforeIds: number[] = [];
  state.sendRequest = async (method, params) => {
    if (method === "v4/conversation/subscribe") {
      state.handleConversationFrame({ topic: "conversation/A", subscriptionId: "sub", fromSeq: 0, toSeq: 5,
        payload: { kind: "snapshot", snapshot: { logEpoch: "epoch", seq: 5, rows: { totalCount: 500,
          window: [{ rowId: 400, kind: "userInput", entityId: "current-user-message", text: "当前问题" }],
        } } } });
      return { ack: { subscriptionId: "sub" } };
    }
    assert.equal(method, "v4/conversation/rowsRange");
    const before = (params as { beforeRowId: number }).beforeRowId;
    beforeIds.push(before);
    return { atLogEpoch: "epoch", hasMore: before === 400, rows: before === 400
      ? [{ rowId: 200, kind: "assistantText", entityId: "shared-assistant-message", text: "较早正文" }]
      : [{ rowId: 1, kind: "userInput", entityId: "old-user-message", text: "旧问题" }] };
  };
  try {
    await client.prepareViewChange();
    await state.subscribeConversation();
    const history = await client.loadHistory();
    assert.equal(history.items[0].id, "current-user-message");
    assert.equal(history.truncated, true);
    const page = await client.olderMessages("current-user-message", "old-user-message");
    assert.deepEqual(beforeIds, [400, 200]);
    assert.deepEqual(page.items.map(item => item.id), ["old-user-message", "projection:200"]);
    assert.equal(page.more, false);
  } finally { client.dispose(); }
});

test("a desktop model switch between turns becomes a transcript separator", async () => {
  const { client, state, events } = fixture();
  const frame = (fromSeq: number, toSeq: number, payload: unknown) => ({
    topic: "conversation/A", subscriptionId: "model-rows", fromSeq, toSeq, payload,
  });
  const marker = {
    type: "modelChange",
    fromProvider: "deepseek",
    fromModel: "deepseek-flash",
    toProvider: "example",
    toModel: "GLM-5.3-Flash",
    toThought: "max",
  };
  state.sendRequest = async (method) => {
    if (method === "v4/conversation/subscribe") {
      state.handleConversationFrame(frame(0, 4, { kind: "snapshot", snapshot: { logEpoch: "epoch", seq: 4, rows: { window: [
        { rowId: 1, kind: "turnHeader", turnId: "t1", state: "completedSuccess" },
        { rowId: 2, kind: "userInput", turnId: "t1", entityId: "q1", origin: "realUser", text: "第一问" },
        { rowId: 3, kind: "assistantText", turnId: "t1", text: "用第一个模型", state: "complete" },
        { rowId: 4, kind: "timelineMarker", turnId: "t1", marker: { type: "modelChange", toProvider: "deepseek", toModel: "deepseek-flash", toThought: "low" } },
      ] } } }));
      return { ack: { subscriptionId: "model-rows", logEpoch: "epoch" } };
    }
    return {};
  };
  try {
    await client.prepareViewChange();
    await state.subscribeConversation();
    client.endViewChange();
    const opened = events.filter(event => event.type === "transcript_sync").at(-1)?.data as { items?: HistoryItem[] };
    assert.equal(opened?.items?.some(item => item.steps?.some(step => step.kind === "model")), false);
    const before = events.filter(event => event.type === "transcript_sync").length;
    state.handleConversationFrame(frame(4, 6, { kind: "deltas", deltas: [
      { op: "row.appended", row: { rowId: 5, kind: "timelineMarker", turnId: "t2", marker } },
      { op: "row.appended", row: { rowId: 6, kind: "turnHeader", turnId: "t2", state: "completedSuccess" } },
      { op: "row.appended", row: { rowId: 7, kind: "userInput", turnId: "t2", entityId: "q2", origin: "realUser", text: "第二问" } },
    ] }));
    const added = events.filter(event => event.type === "transcript_sync").slice(before);
    assert.equal(added.length, 1);
    const items = (added[0].data as { items?: HistoryItem[] }).items ?? [];
    const mark = items.find(item => item.steps?.some(step => step.kind === "model"));
    const step = mark?.steps?.find(item => item.kind === "model");
    assert.equal(step?.kind, "model");
    if (step?.kind !== "model") return;
    assert.equal(step.from, "deepseek-flash");
    assert.equal(step.to, "GLM-5.3-Flash");
    assert.equal(step.fromProvider, "deepseek");
    assert.equal(step.toProvider, "example");
    const second = items.findIndex(item => item.role === "user" && item.text === "第二问");
    assert.ok(mark && second > items.indexOf(mark));
    assert.ok(items.findIndex(item => item.text === "用第一个模型") < items.indexOf(mark));

    const sameNameSwitch = {
      type: "modelChange",
      fromProvider: "deepseek",
      fromModel: "shared-model",
      toProvider: "another-provider",
      toModel: "shared-model",
    };
    const beforeSameName = events.filter(event => event.type === "transcript_sync").length;
    state.handleConversationFrame(frame(6, 9, { kind: "deltas", deltas: [
      { op: "row.appended", row: { rowId: 8, kind: "timelineMarker", turnId: "t3", marker: sameNameSwitch } },
      { op: "row.appended", row: { rowId: 9, kind: "turnHeader", turnId: "t3", state: "completedSuccess" } },
      { op: "row.appended", row: { rowId: 10, kind: "userInput", turnId: "t3", entityId: "q3", origin: "realUser", text: "第三问" } },
    ] }));
    const sameNameSyncs = events.filter(event => event.type === "transcript_sync").slice(beforeSameName);
    assert.equal(sameNameSyncs.length, 1);
    const sameNameItems = (sameNameSyncs[0].data as { items?: HistoryItem[] }).items ?? [];
    const sameNameStep = sameNameItems.flatMap(item => item.steps ?? []).find(item => item.kind === "model" && item.from === "shared-model");
    assert.equal(sameNameStep?.kind, "model");
    if (sameNameStep?.kind !== "model") return;
    assert.equal(sameNameStep.from, "shared-model");
    assert.equal(sameNameStep.to, "shared-model");
    assert.equal(sameNameStep.fromProvider, "deepseek");
    assert.equal(sameNameStep.toProvider, "another-provider");
  } finally { client.dispose(); }
});

test("stored model changes keep names after selections are rewritten", async () => {
  const { client, state } = fixture();
  state.sendRequest = async (method) => {
    assert.equal(method, "session/messages");
    return { messages: [
      {
        info: { id: "rewritten", role: "assistant", finish: "completed" },
        parts: [{
          type: "timeline",
          timelineType: "model_change",
          fromModel: { providerId: "example", modelId: "GLM-5.3", label: "example/GLM-5.3" },
          toModel: { providerId: "deepseek", modelId: "deepseek-flash", label: "deepseek/deepseek-flash" },
        }],
      },
      {
        info: { id: "stored", role: "assistant", finish: "completed" },
        parts: [{
          type: "timeline",
          timelineType: "model_change",
          fromModelSelection: { label: "example/GLM-5.3", modelId: "GLM-5.3" },
          toModel: { providerID: "deepseek", modelID: "deepseek-flash", label: "deepseek/deepseek-flash" },
        }],
      },
      {
        info: { id: "initial-model", role: "assistant", finish: "completed" },
        parts: [{
          type: "timeline",
          timelineType: "model_change",
          toModel: { providerId: "deepseek", modelId: "deepseek-flash", label: "deepseek/deepseek-flash" },
        }],
      },
      {
        info: { id: "provider-only-switch", role: "assistant", finish: "completed" },
        parts: [{
          type: "timeline",
          timelineType: "model_change",
          fromModel: { providerId: "deepseek", modelId: "shared-model", label: "deepseek/shared-model" },
          toModel: { providerId: "another-provider", modelId: "shared-model", label: "another-provider/shared-model" },
        }],
      },
    ] };
  };
  try {
    const history = await client.loadHistory();
    const names = history.items.flatMap(item => item.steps ?? []).filter(step => step.kind === "model");
    assert.equal(names.length, 3);
    assert.deepEqual(names.map(step => step.kind === "model" ? [step.from, step.to, step.fromProvider, step.toProvider] : []), [
      ["GLM-5.3", "deepseek-flash", "example", "deepseek"],
      ["GLM-5.3", "deepseek-flash", "example", "deepseek"],
      ["shared-model", "shared-model", "deepseek", "another-provider"],
    ]);
  } finally { client.dispose(); }
});

test("compact timeline marker updates from compressing to compressed", async () => {
  const { client, state, events } = fixture();
  const frame = (fromSeq: number, toSeq: number, payload: unknown) => ({
    topic: "conversation/A", subscriptionId: "compact-rows", fromSeq, toSeq, payload,
  });
  state.sendRequest = async (method) => {
    if (method === "v4/conversation/subscribe") {
      state.handleConversationFrame(frame(0, 4, { kind: "snapshot", snapshot: { logEpoch: "epoch", seq: 4, rows: { window: [
        { rowId: 1, kind: "turnHeader", turnId: "t1", state: "running" },
        { rowId: 2, kind: "userInput", turnId: "t1", entityId: "q1", origin: "realUser", text: "/compact" },
        { rowId: 3, kind: "timelineMarker", turnId: "t1", marker: { type: "compact", origin: "manual", status: "running" } },
      ] } } }));
      return { ack: { subscriptionId: "compact-rows", logEpoch: "epoch" } };
    }
    return {};
  };
  try {
    await client.prepareViewChange();
    await state.subscribeConversation();
    client.endViewChange();
    const opened = events.filter(event => event.type === "transcript_sync").at(-1)?.data as { items?: HistoryItem[] };
    const running = opened?.items?.flatMap(item => item.steps ?? []).find(step => step.kind === "compact");
    assert.equal(running?.kind, "compact");
    if (running?.kind !== "compact") return;
    assert.equal(running.status, "running");
    assert.equal(running.origin, "manual");
    const before = events.filter(event => event.type === "transcript_sync").length;
    state.handleConversationFrame(frame(4, 5, { kind: "deltas", deltas: [
      { op: "row.upserted", row: { rowId: 3, kind: "timelineMarker", turnId: "t1", marker: { type: "compact", origin: "manual", status: "success" } } },
    ] }));
    const added = events.filter(event => event.type === "transcript_sync").slice(before);
    assert.equal(added.length, 1);
    const done = (added[0].data as { items?: HistoryItem[] }).items
      ?.flatMap(item => item.steps ?? [])
      .find(step => step.kind === "compact");
    assert.equal(done?.kind, "compact");
    if (done?.kind !== "compact") return;
    assert.equal(done.status, "success");
  } finally { client.dispose(); }
});

test("a finished goal check stays on the turn it closed", async () => {
  const { client, state, events } = fixture();
  state.sendRequest = async (method) => {
    if (method === "v4/conversation/subscribe") {
      state.handleConversationFrame({ topic: "conversation/A", subscriptionId: "goal-rows", fromSeq: 0, toSeq: 4,
        payload: { kind: "snapshot", snapshot: { logEpoch: "epoch", seq: 4, rows: { window: [
          { rowId: 1, kind: "turnHeader", turnId: "t1", state: "completedSuccess" },
          { rowId: 2, kind: "userInput", turnId: "t1", entityId: "q1", origin: "realUser", text: "目标问题" },
          { rowId: 3, kind: "assistantText", turnId: "t1", text: "做完了", state: "complete" },
          { rowId: 4, kind: "timelineMarker", turnId: "t1", marker: { type: "goalVerify", iteration: 2, outcome: "running" } },
          { rowId: 5, kind: "timelineMarker", turnId: "t1", marker: { type: "goalVerify", iteration: 2, outcome: "pass" } },
          { rowId: 6, kind: "turnHeader", turnId: "t2", state: "completedSuccess" },
          { rowId: 7, kind: "userInput", turnId: "t2", entityId: "q2", origin: "realUser", text: "下一个问题" },
          { rowId: 8, kind: "assistantText", turnId: "t2", text: "继续", state: "complete" },
        ] } } } });
      return { ack: { subscriptionId: "goal-rows", logEpoch: "epoch" } };
    }
    return {};
  };
  try {
    await client.prepareViewChange();
    await state.subscribeConversation();
    client.endViewChange();
    const transcript = events.filter(event => event.type === "transcript_sync").at(-1);
    const items = (transcript?.data as { items?: HistoryItem[] } | undefined)?.items ?? [];
    const done = items.find(item => item.steps?.some(step => step.kind === "text" && step.text === "做完了"));
    const goalSteps = done?.steps?.filter(step => step.kind === "goal") ?? [];
    assert.equal(goalSteps.length, 1);
    const goal = goalSteps[0];
    assert.equal(goal?.kind, "goal");
    if (goal?.kind !== "goal") return;
    assert.equal(goal.passed, true);
    assert.equal(goal.iteration, 2);
    const later = items.findIndex(item => item.role === "user" && item.text === "下一个问题");
    assert.ok(done && later > items.indexOf(done));
  } finally { client.dispose(); }
});

test("a finished goal check redraws the transcript before the next question", async () => {
  const { client, state, events } = fixture();
  const frame = (fromSeq: number, toSeq: number, payload: unknown) => ({
    topic: "conversation/A", subscriptionId: "goal-rows", fromSeq, toSeq, payload,
  });
  state.sendRequest = async (method) => {
    if (method === "v4/conversation/subscribe") {
      state.handleConversationFrame(frame(0, 4, { kind: "snapshot", snapshot: { logEpoch: "epoch", seq: 4, rows: { window: [
        { rowId: 1, kind: "turnHeader", turnId: "t1", state: "running" },
        { rowId: 2, kind: "userInput", turnId: "t1", entityId: "q1", origin: "realUser", text: "目标问题" },
        { rowId: 3, kind: "assistantText", turnId: "t1", text: "做完了", state: "complete" },
        { rowId: 5, kind: "timelineMarker", turnId: "t1", marker: { type: "goalVerify", iteration: 1, outcome: "running" } },
      ] } } }));
      return { ack: { subscriptionId: "goal-rows", logEpoch: "epoch" } };
    }
    return {};
  };
  try {
    await client.prepareViewChange();
    await state.subscribeConversation();
    client.endViewChange();
    const before = events.filter(event => event.type === "transcript_sync").length;
    const opened = events.filter(event => event.type === "transcript_sync").at(-1)?.data as { items?: HistoryItem[] };
    assert.equal(opened?.items?.some(item => item.steps?.some(step => step.kind === "goal")), false);
    state.handleConversationFrame(frame(4, 5, { kind: "deltas", deltas: [
      { op: "row.upserted", row: { rowId: 5, kind: "timelineMarker", turnId: "t1", marker: { type: "goalVerify", iteration: 1, outcome: "pass" } } },
      { op: "state.updated", patch: { goal: { objective: "发布 1.5 版本", status: "verified", iteration: 1, timeUsedSeconds: 3, verifications: [{ iteration: 1, outcome: "pass", anchorRowId: 5 }] } } },
    ] }));
    const added = events.filter(event => event.type === "transcript_sync").slice(before);
    assert.equal(added.length, 1);
    const items = (added[0].data as { items?: HistoryItem[] }).items ?? [];
    const done = items.find(item => item.steps?.some(step => step.kind === "text" && step.text === "做完了"));
    const goal = done?.steps?.find(step => step.kind === "goal");
    assert.equal(goal?.kind, "goal");
    if (goal?.kind !== "goal") return;
    assert.equal(goal.passed, true);
    assert.equal(goal.iteration, 1);
  } finally { client.dispose(); }
});

test("a stored goal verification redraws the closing sentence without another question", async () => {
  const { client, state, events } = fixture();
  const frame = (fromSeq: number, toSeq: number, payload: unknown) => ({
    topic: "conversation/A", subscriptionId: "goal-rows", fromSeq, toSeq, payload,
  });
  state.sendRequest = async (method) => {
    if (method === "v4/conversation/subscribe") {
      state.handleConversationFrame(frame(0, 4, { kind: "snapshot", snapshot: { logEpoch: "epoch", seq: 4, rows: { window: [
        { rowId: 1, kind: "turnHeader", turnId: "t1", state: "running" },
        { rowId: 2, kind: "userInput", turnId: "t1", entityId: "q1", origin: "realUser", text: "目标问题" },
        { rowId: 3, kind: "assistantText", turnId: "t1", text: "做完了", state: "complete" },
      ] }, goal: { objective: "发布 1.5 版本", status: "verifying", iteration: 1, timeUsedSeconds: 2, verifications: [] } } }));
      return { ack: { subscriptionId: "goal-rows", logEpoch: "epoch" } };
    }
    return {};
  };
  try {
    await client.prepareViewChange();
    await state.subscribeConversation();
    client.endViewChange();
    const before = events.filter(event => event.type === "transcript_sync").length;
    state.handleConversationFrame(frame(4, 5, { kind: "deltas", deltas: [
      { op: "state.updated", patch: { goal: { objective: "发布 1.5 版本", status: "verified", iteration: 1, timeUsedSeconds: 3, verifications: [{ iteration: 1, outcome: "pass", anchorRowId: 3 }] } } },
    ] }));
    const added = events.filter(event => event.type === "transcript_sync").slice(before);
    assert.equal(added.length, 1);
    const items = (added[0].data as { items?: HistoryItem[] }).items ?? [];
    const done = items.find(item => item.steps?.some(step => step.kind === "text" && step.text === "做完了"));
    const goal = done?.steps?.find(step => step.kind === "goal");
    assert.equal(goal?.kind, "goal");
    if (goal?.kind !== "goal") return;
    assert.equal(goal.passed, true);
    assert.equal(goal.iteration, 1);
    const later = items.filter(item => item.role === "user");
    assert.equal(later.length, 1);
  } finally { client.dispose(); }
});

test("restored work folds receive the desktop active duration instead of elapsed wall time", async () => {
  const { client, state } = fixture();
  state.sendRequest = async () => {
    state.handleConversationFrame({ topic: "conversation/A", subscriptionId: "timed", fromSeq: 0, toSeq: 5,
      payload: { kind: "snapshot", snapshot: { logEpoch: "epoch", seq: 5, rows: { window: [
        { rowId: 1, kind: "turnHeader", turnId: "turn", state: "completedSuccess",
          startedAt: 1000000, endedAt: 1120000, activeMs: 65000 },
        { rowId: 2, kind: "reasoning", turnId: "turn", text: "完整思考", state: "complete", durationMs: 10000 },
        { rowId: 3, kind: "assistantText", turnId: "turn", text: "完整正文", state: "complete" },
      ] } } } });
    return { ack: { subscriptionId: "timed" } };
  };
  try {
    await client.prepareViewChange();
    await state.subscribeConversation();
    const history = await client.loadHistory();
    assert.equal(history.items.length, 2);
    for (const item of history.items) {
      assert.equal(item.createdAt, 1000000);
      assert.equal(item.endedAt, 1120000);
      assert.equal(item.workDurationMs, 65000);
      assert.equal(item.turnId, "turn");
      assert.equal(item.logEpoch, "epoch");
      assert.ok(typeof item.rowId === "number");
      assert.equal(item.running, false);
    }
  } finally { client.dispose(); }
});

test("running turn timing updates preserve streamed text events", async () => {
  const { client, state, events } = fixture();
  const frame = (fromSeq: number, toSeq: number, payload: unknown) => ({
    topic: "conversation/A", subscriptionId: "running-header", fromSeq, toSeq, payload,
  });
  state.sendRequest = async method => {
    if (method === "v4/conversation/subscribe") {
      state.handleConversationFrame(frame(0, 1, { kind: "snapshot", snapshot: {
        logEpoch: "epoch", seq: 1, control: { phase: "running" }, rows: { window: [
          { rowId: 1, kind: "turnHeader", turnId: "turn", state: "running", activeMs: 10 },
          { rowId: 2, kind: "userInput", turnId: "turn", entityId: "question", origin: "realUser", text: "问题" },
          { rowId: 3, kind: "assistantText", turnId: "turn", text: "起", state: "streaming" },
        ] },
      } }));
      return { ack: { subscriptionId: "running-header", logEpoch: "epoch" } };
    }
    return {};
  };
  try {
    await client.prepareViewChange();
    await state.subscribeConversation();
    client.endViewChange();
    events.length = 0;
    state.handleConversationFrame(frame(1, 2, { kind: "deltas", deltas: [
      { op: "row.upserted", row: { rowId: 1, kind: "turnHeader", turnId: "turn", state: "running", activeMs: 20 } },
      { op: "row.upserted", row: { rowId: 3, kind: "assistantText", turnId: "turn", text: "起始", state: "streaming" } },
    ] }));
    assert.ok(events.some(event => event.type === "assistant_text_delta" && (event.data as { fullText?: string }).fullText === "起始"));
    assert.ok(!events.some(event => event.type === "transcript_sync"));
  } finally { client.dispose(); }
});

test("a late completed turn header republishes the transcript with its work duration", async () => {
  const { client, state, events } = fixture();
  const frame = (fromSeq: number, toSeq: number, payload: unknown) => ({
    topic: "conversation/A", subscriptionId: "late-header", fromSeq, toSeq, payload,
  });
  state.sendRequest = async method => {
    if (method === "v4/conversation/subscribe") {
      state.handleConversationFrame(frame(0, 1, { kind: "snapshot", snapshot: {
        logEpoch: "epoch", seq: 1, rows: { window: [
          { rowId: 2, kind: "userInput", turnId: "turn", entityId: "question", origin: "realUser", text: "问题" },
          { rowId: 3, kind: "reasoning", turnId: "turn", text: "思考", state: "complete" },
        ] },
      } }));
      return { ack: { subscriptionId: "late-header", logEpoch: "epoch" } };
    }
    return {};
  };
  try {
    await client.prepareViewChange();
    await state.subscribeConversation();
    client.endViewChange();
    const before = events.filter(event => event.type === "transcript_sync").length;
    state.handleConversationFrame(frame(1, 2, { kind: "deltas", deltas: [
      { op: "row.appended", row: { rowId: 1, kind: "turnHeader", turnId: "turn", state: "completedSuccess",
        startedAt: 1000, endedAt: 121000, activeMs: 65000 } },
    ] }));
    const updates = events.filter(event => event.type === "transcript_sync").slice(before);
    assert.equal(updates.length, 1, "completed timing update did not redraw history");
    const items = (updates[0].data as { items?: HistoryItem[] }).items ?? [];
    const work = items.find(item => item.role === "assistant");
    assert.equal(work?.workDurationMs, 65000);
    assert.equal(work?.endedAt, 121000);

    const beforeCorrection = events.filter(event => event.type === "transcript_sync").length;
    state.handleConversationFrame(frame(2, 3, { kind: "deltas", deltas: [
      { op: "row.upserted", row: { rowId: 1, kind: "turnHeader", turnId: "turn", state: "completedSuccess",
        startedAt: 1000, endedAt: 126000, activeMs: 70000 } },
    ] }));
    const corrections = events.filter(event => event.type === "transcript_sync").slice(beforeCorrection);
    assert.equal(corrections.length, 1, "corrected turn timing did not redraw history");
    const corrected = (corrections[0].data as { items?: HistoryItem[] }).items ?? [];
    assert.equal(corrected.find(item => item.role === "assistant")?.workDurationMs, 70000);
  } finally { client.dispose(); }
});

test("a failed switch does not block the next switch", async () => {
  const { client, state } = fixture();
  state.afterSessionAttached = async () => {};
  state.adoptResumedModel = async () => {};
  state.sendRequest = async (method, params) => {
    if (method === "session/resume" && (params as { sessionId: string }).sessionId === "bad") throw new Error("missing");
    return { sessions: [], messages: [] };
  };
  const bad = client.switchSession("bad");
  const good = client.switchSession("B");
  await assert.rejects(bad, /missing/);
  await good;
  assert.equal(client.currentSessionId, "B");
});

test("a timed-out switch can be retried for the same session", async () => {
  const { client, state } = fixture();
  let attempts = 0;
  state.afterSessionAttached = async () => {};
  state.adoptResumedModel = async () => {};
  state.sendRequest = async (method, _params, timeoutMs) => {
    if (method === "session/resume") {
      attempts++;
      if (attempts === 1) throw new Error(`Request session/resume timed out after ${timeoutMs}ms`);
      return {};
    }
    return { sessions: [], messages: [] };
  };
  await assert.rejects(client.switchSession("B"), /timed out/);
  assert.equal(client.currentSessionId, "B");
  assert.equal(client.sessionAttached, false);
  await client.switchSession("B");
  assert.equal(attempts, 2);
  assert.equal(client.currentSessionId, "B");
  assert.equal(client.sessionAttached, true);
});

test("a conversation subscribe timeout keeps the resumed session readable and retryable", async () => {
  const { client, state } = fixture();
  let conversationSubscribes = 0;
  const settings = {
    model: { current: { providerId: "p", modelId: "m" } },
    mode: { current: "build" },
    permission: { mode: "build" },
    thoughtLevel: { enabled: false },
  };
  state.sendRequest = async (method, params) => {
    if (method === "session/list") return { sessions: [] };
    if (method === "session/resume") return {};
    if (method === "session/subscribe") {
      return { snapshot: { session: { sessionId: "B", title: "B", model: settings.model.current }, settings } };
    }
    if (method === "session/read") {
      return { session: { sessionId: "B", title: "B", model: settings.model.current }, settings };
    }
    if (method === "v4/conversation/subscribe") {
      conversationSubscribes++;
      if (conversationSubscribes === 1) throw new Error("Request v4/conversation/subscribe timed out after 30000ms");
      const topic = (params as { topic?: string } | undefined)?.topic ?? "conversation/B";
      state.handleConversationFrame({
        topic, subscriptionId: "retry-sub", fromSeq: 0, toSeq: 1,
        payload: { kind: "snapshot", snapshot: { logEpoch: "epoch", seq: 1, rows: { window: [] } } },
      });
      return { ack: { subscriptionId: "retry-sub", logEpoch: "epoch" } };
    }
    return {};
  };
  try {
    await assert.rejects(client.switchSession("B"), /v4\/conversation\/subscribe timed out/);
    assert.equal(client.currentSessionId, "B");
    assert.equal((client as unknown as { sessionReadable: boolean }).sessionReadable, true);
    assert.equal(client.sessionAttached, false);
    assert.equal(client.diagnosticSummary().sessionAttached, false);
    await client.switchSession("B");
    assert.equal(conversationSubscribes, 2);
    assert.equal(client.currentSessionId, "B");
    assert.equal(client.sessionAttached, true);
  } finally { client.dispose(); }
});

test("sanitized backend snapshot hides runtime inputs so they cannot split a workbar", async () => {
  const { client, state, events } = fixture();
  state.sessionId = "workbar-fixture";
  const backendFrame = structuredClone(workbarBackendSnapshot);
  state.sendRequest = async (_method, params) => {
    if ((params as { topic?: string })?.topic === backendFrame.topic) {
      state.handleConversationFrame(backendFrame);
      return { ack: { subscriptionId: backendFrame.subscriptionId, logEpoch: "fixture-epoch" } };
    }
    return { sessions: [], messages: [] };
  };
  try {
    await client.prepareViewChange();
    await state.subscribeConversation();
    const history = await client.loadHistory();
    assert.deepEqual(history.items.filter(item => item.role === "user").map(item => item.text), ["FIXTURE_QUESTION"]);
    assert.deepEqual(history.items.filter(item => item.role === "assistant").map(item => {
      const step = item.steps?.[0];
      return step && "text" in step ? step.text : undefined;
    }), [
      "FIXTURE_THOUGHT_BEFORE",
      "FIXTURE_INTERMEDIATE_REPLY",
      "FIXTURE_THOUGHT_AFTER",
      "FIXTURE_FINAL_REPLY",
    ]);
    const assistantItems = history.items.filter(item => item.role === "assistant");
    assert.equal(new Set(assistantItems.map(item => item.turnId)).size, 2,
      "fixture must retain the backend's adjacent turn IDs");
    assert.ok(!history.items.some(item => item.text.includes("FIXTURE_HIDDEN_")));
    const conversation = events.filter(event => event.type === "conversation_sync").at(-1)?.data as {
      editable?: { target?: { rowId?: number; entityId?: string } };
    } | undefined;
    assert.deepEqual(conversation?.editable?.target, { rowId: 2, entityId: "fixture-question" },
      "hidden backend input displaced the real question's edit target");
  } finally { client.dispose(); }
});

test("session_ready carries the snapshot's builtin and custom slash commands", async () => {
  const { client, state, events } = fixture();
  state.sendRequest = async (method: string) => {
    if (method === "session/create") { state.sessionId = "NEW"; return {}; }
    if (method === "v4/conversation/subscribe") {
      state.handleConversationFrame({ topic: "conversation/NEW", subscriptionId: "conv", fromSeq: 0, toSeq: 1,
        payload: { kind: "snapshot", snapshot: { logEpoch: "epoch", seq: 1, rows: { window: [] } } } });
      return { ack: { subscriptionId: "conv" } };
    }
    if (method === "session/subscribe") {
      return { snapshot: { session: { model: { providerId: "test-provider", modelId: "test-model" } }, slashCommands: [
        { name: "goal", description: "Show or set the current session goal.", inputHint: "/goal [objective]", source: "builtin" },
        { name: "my-report", description: "Custom user command.", inputHint: "/my-report [args]", source: "user" },
        { name: 7, description: "invalid entry is dropped" },
      ] } };
    }
    return { sessions: [], messages: [] };
  };
  try {
    await state.createSession(true);
    const ready = events.find(event => event.type === "session_ready");
    assert.deepEqual(client.confirmedModel(), { providerId: "test-provider", modelId: "test-model" });
    assert.deepEqual((ready?.data as { slashCommands?: unknown }).slashCommands, [
      { name: "goal", description: "Show or set the current session goal.", inputHint: "/goal [objective]" },
      { name: "my-report", description: "Custom user command.", inputHint: "/my-report [args]" },
    ]);
  } finally { client.dispose(); }
});

function acceptSpawnedSession(state: Internals): void {
  const coldSnapshot = { session: {}, settings: { model: { available: [] } } };
  state.sendRequest = async (method: string) => {
    if (method === "session/create") { state.sessionId = "NEW"; return {}; }
    if (method === "session/read") return coldSnapshot;
    if (method === "v4/conversation/subscribe") {
      state.handleConversationFrame({ topic: "conversation/NEW", subscriptionId: "conv", fromSeq: 0, toSeq: 1,
        payload: { kind: "snapshot", snapshot: { logEpoch: "epoch", seq: 1, rows: { window: [] } } } });
      return { ack: { subscriptionId: "conv" } };
    }
    if (method === "session/subscribe") return { snapshot: coldSnapshot };
    return {};
  };
}

test("dispose does not signal a child that failed to start", async () => {
  const { client, state } = fixture();
  acceptSpawnedSession(state);
  const kills: Array<NodeJS.Signals | number | undefined> = [];
  let proc: ChildProcess | null = null;
  try {
    await client.start({ createNew: true });
    proc = (client as unknown as { proc: ChildProcess | null }).proc;
    assert.ok(proc, "startup must retain the child until dispose");
    assert.equal(proc.pid, undefined);
    // A failed spawn still has a live handle. Calling the real kill() here can
    // signal pid 0 and terminate the test process group.
    proc.kill = (signal) => {
      kills.push(signal);
      return true;
    };
    client.dispose();
    assert.deepEqual(kills, []);
  } finally {
    const current = (client as unknown as { proc: ChildProcess | null }).proc ?? proc;
    if (current) current.kill = () => true;
    client.dispose();
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test("dispose terminates a running app-server", async (t) => {
  const os = require("os") as typeof import("os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-client-dispose-"));
  const script = path.join(root, "stay-alive.js");
  fs.writeFileSync(script, "setInterval(() => {}, 1000);\n");
  let client: ZCodeClient | undefined;
  let proc: ChildProcess | null = null;
  t.after(() => {
    const live = proc ?? (client as unknown as { proc?: ChildProcess | null } | undefined)?.proc ?? null;
    if (live && live.exitCode === null && live.signalCode === null) {
      try { ChildProcess.prototype.kill.call(live, "SIGKILL"); } catch { /* already exited */ }
    }
    client?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  client = new ZCodeClient({ binaryPath: script, workspacePath: root, onEvent: () => undefined });
  const state = client as unknown as Internals;
  acceptSpawnedSession(state);
  await client.start({ createNew: true });
  proc = (client as unknown as { proc: ChildProcess | null }).proc;
  assert.ok(proc?.pid && proc.pid > 0);
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const kill = proc.kill.bind(proc);
  proc.kill = (signal) => {
    signals.push(signal);
    return kill(signal);
  };
  client.dispose();
  assert.deepEqual(signals, ["SIGTERM"]);
  if (proc.exitCode === null && proc.signalCode === null) {
    await Promise.race([
      new Promise<void>((resolve) => proc!.once("exit", resolve)),
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]);
  }
  assert.equal(proc.signalCode, "SIGTERM");
});

test("stopping A leaves B's permission and input requests pending", async () => {
  const { client, state } = fixture();
  const replies: unknown[] = [];
  state.write = (reply) => replies.push(reply);
  state.sendRequest = async () => ({});
  for (const sessionId of ["A", "B"]) {
    state.pendingPermissions.set(sessionId, { rpcIds: [sessionId], requestId: sessionId, sessionId, toolName: "edit", options: [] });
    state.pendingUserInputs.set(sessionId, { rpcIds: [sessionId + "-input"], requestId: sessionId, sessionId, questions: [] });
  }
  await client.stopGeneration();
  assert.deepEqual([...state.pendingPermissions.keys()], ["B"]);
  assert.deepEqual([...state.pendingUserInputs.keys()], ["B"]);
  assert.deepEqual(replies, [
    { id: "A", result: { decision: "deny", reason: "Stopped" } },
    { id: "A-input", result: { action: "cancel", reason: "Stopped" } },
  ]);
  state.sessionId = null;
  await client.stopGeneration();
  assert.equal(state.pendingPermissions.size, 1);
});

for (const method of ["loadHistory", "olderMessages"] as const) {
  test(`${method} discards an old response even after switching away and back`, async () => {
    const { client, state } = fixture();
    const response = deferred<unknown>();
    state.sendRequest = () => response.promise;
    const loading = method === "loadHistory" ? client.loadHistory() : client.olderMessages("last");
    state.sessionGeneration++;
    response.resolve({ messages: [
      { info: { id: "old", role: "user" }, parts: [{ type: "text", text: "old A" }] },
      { info: { id: "last", role: "user" }, parts: [{ type: "text", text: "last A" }] },
    ] });
    assert.deepEqual((await loading).items, []);
    assert.equal(state.historyCache, null);
  });
}

test("sending during a switch is rejected before an RPC can target the wrong session", async () => {
  const { client, state } = fixture();
  state.sendRequest = async () => { throw new Error("unexpected RPC"); };
  await client.prepareViewChange();
  await assert.rejects(client.sendMessage("hello"), /正在切换/);
});


for (const destination of ["B", "A"]) {
  test(`late session snapshot is discarded after switching to ${destination}`, async () => {
    const { client, state, events } = fixture();
    const response = deferred<unknown>();
    state.sendRequest = () => response.promise;
    const reading = client.emitSessionControls();
    state.sessionId = destination;
    state.sessionGeneration += destination === "A" ? 2 : 1;
    const controls = { mode: "build", thoughtEnabled: false, thoughtLevels: [] };
    state.lastControls = controls;
    state.lastContext = { used: 1000, max: 128000 };
    state.lastRevision = 7;
    response.resolve({ runtime: { stateRevision: 123, contextUsage: { used: 96000, size: 128000 } }, settings: { mode: { current: "plan" } } });
    await reading;
    assert.strictEqual(state.lastControls, controls);
    assert.deepEqual(state.lastContext, { used: 1000, max: 128000 });
    assert.equal(state.lastRevision, 7);
    assert.deepEqual(events, []);
    client.dispose();
  });
}

test("a saved permission survives the projection's default build mode", async () => {
  const { client, state } = fixture();
  state.sendRequest = async () => ({});
  await client.setMode("yolo");
  state.sendRequest = async () => ({
    session: { mode: "build" },
    settings: { mode: { current: "yolo" }, permission: { mode: "yolo" } },
  });
  await client.emitSessionControls();
  assert.equal(state.lastControls.mode, "yolo");
  assert.equal(state.lastControls.baseMode, "yolo");
  state.handleSessionEvent({ type: "session.updated", sessionId: "A", payload: { mode: "build" } });
  assert.equal(state.lastControls.mode, "yolo");
  assert.equal(state.lastControls.baseMode, "yolo");
  client.dispose();
});

test("a base-mode snapshot does not clear an active plan", async () => {
  const { client, state } = fixture();
  state.sendRequest = async () => ({});
  await client.setMode("plan");
  assert.equal(state.lastControls.mode, "plan");
  state.sendRequest = async () => ({ settings: { mode: { current: "build" }, permission: { mode: "build" } } });
  await client.emitSessionControls();
  assert.equal(state.lastControls.mode, "plan");
  state.sendRequest = async () => ({ settings: { mode: { current: "edit" }, planEnabled: false } });
  await client.emitSessionControls();
  assert.equal(state.lastControls.mode, "edit");
  client.dispose();
});

test("a base-mode session.updated write-back keeps an active plan until the plan flag clears", async () => {
  const { client, state, events } = fixture();
  state.sendRequest = async () => ({});
  await client.setMode("plan");
  events.length = 0;

  state.handleSessionEvent({ type: "session.updated", sessionId: "A", payload: { mode: "build" } });
  assert.equal(state.lastControls.mode, "plan");
  assert.ok(!events.some((event) => event.type === "session_controls"));

  state.handleSessionEvent({ type: "session.updated", sessionId: "A", payload: { mode: "edit", planEnabled: false } });
  assert.equal(state.lastControls.mode, "edit");
  assert.equal(state.lastControls.planEnabled, false);
  assert.ok(events.some((event) => event.type === "session_controls"));

  client.dispose();
});

test("current session snapshot still updates controls, usage and revision", async () => {
  const { client, state, events } = fixture();
  state.sendRequest = async () => ({ runtime: { stateRevision: 9, contextUsage: { used: 300, size: 128000 } }, settings: { mode: { current: "plan" } } });
  await client.emitSessionControls();
  assert.equal(state.lastControls.mode, "plan");
  assert.deepEqual(state.lastContext, { used: 300, max: 128000 });
  assert.equal(state.lastRevision, 9);
  assert.ok(events.some(event => event.type === "context_usage"));
  assert.ok(events.some(event => event.type === "session_controls"));
  client.dispose();
});

test("disposed client ignores pending snapshot", async () => {
  const { client, state, events } = fixture();
  const response = deferred<unknown>();
  state.sendRequest = () => response.promise;
  const reading = client.emitSessionControls();
  client.dispose();
  events.length = 0;
  response.resolve({ settings: { mode: { current: "plan" } } });
  await reading;
  assert.equal(state.lastControls.mode, "build");
  assert.deepEqual(events, []);
});

for (const command of ["mode", "thought"] as const) {
  test(`late ${command} acknowledgement cannot overwrite new session controls`, async () => {
    const { client, state, events } = fixture();
    const response = deferred<unknown>();
    state.sendRequest = () => response.promise;
    const setting = command === "mode" ? client.setMode("plan") : client.setThoughtLevel("max");
    state.sessionId = "B";
    state.sessionGeneration++;
    const controls = { mode: "build", thoughtEnabled: true, thoughtLevel: "low", thoughtLevels: [] };
    state.lastControls = controls;
    response.resolve({});
    await setting;
    assert.strictEqual(state.lastControls, controls);
    assert.deepEqual(events, []);
    client.dispose();
  });
}

test("stale model command cannot retry against the newly selected session", async () => {
  const { client, state, events } = fixture();
  const response = deferred<unknown>();
  const requests: unknown[] = [];
  state.sendRequest = async (_method, params) => { requests.push(params); return response.promise; };
  const setting = client.setModel("test", "test-model");
  const rejected = assert.rejects(setting);
  state.sessionId = "B";
  state.sessionGeneration++;
  state.lastRevision = 8;
  response.resolve({ status: "stale", revisionAtDecision: 99 });
  await rejected;
  assert.equal(requests.length, 1);
  assert.equal((requests[0] as { sessionId: string }).sessionId, "A");
  assert.equal(state.lastRevision, 8);
  assert.equal(state.liveModelReady, false);
  assert.deepEqual(events, []);
  client.dispose();
});

test("model switch retries with the target model's reasoning default after an inherited effort is rejected", async () => {
  const { client, state } = fixture();
  const target = { providerId: "ant-provider", modelId: "qwen3.8-flash" };
  state.lastControls = {
    mode: "build",
    baseMode: "build",
    planEnabled: false,
    thoughtEnabled: true,
    thoughtLevel: "high",
    thoughtLevels: [{ value: "high", label: "High" }],
  };
  state.alignAndEmitModel = async () => {};
  const commands: Array<{ provider: string; model: string; thought: string }> = [];
  let backendModel = { providerId: "old-provider", modelId: "old-model" };
  const targetSnapshot = () => ({
    session: { sessionId: "A", model: backendModel },
    settings: {
      model: { current: backendModel },
      thoughtLevel: {
        enabled: true,
        current: "medium",
        defaultLevel: "medium",
        available: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
        ],
      },
    },
  });
  state.sendRequest = async (method, params) => {
    if (method === "v4/command") {
      const command = params as { payload: { provider: string; model: string; thought: string } };
      commands.push(command.payload);
      if (commands.length === 1) {
        // The backend changes models before discovering the inherited effort is invalid.
        backendModel = target;
        throw new Error("Reasoning level is required for ant-provider/qwen3.8-flash");
      }
      return { status: "accepted", revisionAtDecision: 2 };
    }
    if (method === "session/read") return targetSnapshot();
    return {};
  };

  try {
    await client.setModel(target.providerId, target.modelId);
    assert.deepEqual(commands.map(command => command.thought), ["high", "medium"]);
    assert.equal(state.lastControls.thoughtLevel, "medium");
    assert.deepEqual(state.lastControls.thoughtLevels.map(level => level.value), ["low", "medium"]);
  } finally {
    client.dispose();
  }
});

test("discarded snapshot cannot trigger fallback model selection in a new session", async () => {
  const { client, state, events } = fixture();
  const response = deferred<unknown>();
  let requests = 0;
  state.sendRequest = () => { requests++; return response.promise; };
  const ensuring = state.ensureSessionModel();
  state.sessionId = "B";
  state.sessionGeneration++;
  response.resolve({ settings: { model: { current: { providerId: "test", modelId: "test-model" } } } });
  await ensuring;
  assert.equal(requests, 1);
  assert.equal(state.liveModelReady, false);
  assert.deepEqual(events, []);
  client.dispose();
});

test("same provider reuses the desktop login without another exchange", async () => {
  let calls = 0;
  const runtime = {
    providerId: "prov", providerName: "Prov", kind: "anthropic", baseURL: "https://example.invalid",
    apiKey: "local-key", modelId: "m1", models: {}, source: "desktop-apikey" as const,
  };
  const client = new ZCodeClient({
    binaryPath: "/unused", workspacePath: "/test", runtime,
    onEvent: () => undefined,
    resolveSessionRuntime: async () => { calls++; return null; },
  });
  const state = client as unknown as Internals & { loginStale: boolean };
  state.sessionId = "A";
  await state.alignAndEmitModel({ providerId: "prov", modelId: "m2" });
  assert.equal(calls, 0);
  assert.equal((state.sessionRuntime as { modelId: string }).modelId, "m2");
  state.loginStale = true;
  await state.alignAndEmitModel({ providerId: "prov", modelId: "m3" });
  assert.equal(calls, 1);
  assert.equal(state.sessionRuntime, null);
  client.dispose();
});

test("a team account id reuses the builtin desktop login without another exchange", async () => {
  let calls = 0;
  const runtime = {
    providerId: "builtin:bigmodel-coding-plan", providerName: "BigModel", kind: "anthropic",
    baseURL: "https://example.invalid", apiKey: "team-key", modelId: "GLM-5.3-Flash", models: {},
    source: "desktop-team-oauth" as const,
  };
  const client = new ZCodeClient({
    binaryPath: "/unused", workspacePath: "/test", runtime,
    onEvent: () => undefined,
    resolveSessionRuntime: async () => { calls++; return null; },
  });
  const state = client as unknown as Internals;
  state.sessionId = "A";
  await state.alignAndEmitModel({ providerId: "account:bigmodel-team-coding-plan", modelId: "GLM-5.3" });
  assert.equal(calls, 0);
  assert.equal((state.sessionRuntime as { modelId: string }).modelId, "GLM-5.3");
  await state.alignAndEmitModel({ providerId: "account:bigmodel-team-coding-plan", modelId: "GLM-5.3" });
  assert.equal(calls, 0);
  client.dispose();
});

test("session attach waits for the in-flight desktop login before exchanging again", async () => {
  let calls = 0;
  let release: (value: { ok: boolean; runtime: ResolvedRuntime; picker: [] }) => void = () => undefined;
  const pendingLogin = new Promise<{ ok: boolean; runtime: ResolvedRuntime; picker: [] }>((resolve) => {
    release = resolve;
  });
  const client = new ZCodeClient({
    binaryPath: "/unused", workspacePath: "/test", pendingLogin,
    onEvent: () => undefined,
    resolveSessionRuntime: async () => { calls++; return null; },
  });
  const state = client as unknown as Internals;
  state.sessionId = "A";
  let finished = false;
  const aligning = state.alignAndEmitModel({ providerId: "account:bigmodel-team-coding-plan", modelId: "GLM-5.3" })
    .then(() => { finished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(calls, 0);
  release({
    ok: true,
    picker: [],
    runtime: {
      providerId: "builtin:bigmodel-coding-plan", providerName: "BigModel", kind: "anthropic",
      baseURL: "https://example.invalid", apiKey: "team-key", modelId: "GLM-5.3-Flash", models: {},
      source: "desktop-team-oauth",
    },
  });
  await aligning;
  assert.equal(finished, true);
  assert.equal(calls, 0);
  client.dispose();
});

test("a new session created during the overlapped startup login is configured from that login", async () => {
  const login = deferred<{ ok: boolean; runtime: ResolvedRuntime; picker: [] }>();
  const client = new ZCodeClient({ binaryPath: "/unused", workspacePath: "/test", pendingLogin: login.promise, onEvent: () => undefined });
  const state = client as unknown as Omit<Internals, "afterSessionAttached"> & {
    sessionModel: { providerId: string; modelId: string } | null;
    afterSessionAttached: (kind: string, applyModel: boolean, createdRuntime: ResolvedRuntime | null) => Promise<void>;
  };
  const methods: string[] = [];
  let attached: { applyModel: boolean; runtime: ResolvedRuntime | null } | undefined;
  state.sendRequest = async (method) => {
    methods.push(method);
    if (method === "session/create") state.sessionId = "NEW";
    return {};
  };
  state.afterSessionAttached = async (_kind, applyModel, createdRuntime) => { attached = { applyModel, runtime: createdRuntime }; };
  const creating = state.createSession(true);
  await tick();
  assert.deepEqual(methods, [], "session/create was sent before the login settled");
  const runtime: ResolvedRuntime = {
    providerId: "builtin:bigmodel-coding-plan", providerName: "BigModel", kind: "anthropic",
    baseURL: "https://example.invalid", apiKey: "plan-key", modelId: "GLM-5.3", models: {},
    source: "desktop-personal-oauth",
  };
  login.resolve({ ok: true, picker: [], runtime });
  await creating;
  assert.deepEqual(methods, ["session/create"]);
  assert.equal(attached?.applyModel, true);
  assert.equal(attached?.runtime?.providerId, "builtin:bigmodel-coding-plan");
  assert.equal(attached?.runtime?.apiKey, "plan-key");
  assert.deepEqual(state.sessionModel, { providerId: "builtin:bigmodel-coding-plan", modelId: "GLM-5.3" });
  client.dispose();
});

test("startup resume reuses the listed row and a delivered history is not published twice", async () => {
  const { client, state, events } = fixture();
  const methods: string[] = [];
  state.sendRequest = async (method, params) => {
    methods.push(method);
    if (method === "session/list") {
      return { sessions: [{ sessionId: "VALID", title: "valid", model: { providerId: "prov", modelId: "m1" } }] };
    }
    if (method === "session/subscribe") {
      return { snapshot: { session: { title: "valid", model: { providerId: "prov", modelId: "m1" } }, settings: { model: { current: { providerId: "prov", modelId: "m1" }, available: [] }, mode: { current: "build" }, thoughtLevel: { enabled: false } } } };
    }
    if (method === "v4/conversation/subscribe") {
      const topic = (params as { topic?: string } | undefined)?.topic ?? "conversation/VALID";
      state.handleConversationFrame({
        topic,
        subscriptionId: "sub",
        fromSeq: 0,
        toSeq: 1,
        payload: { kind: "snapshot", snapshot: { logEpoch: "epoch", seq: 1, control: { phase: "draft", canStop: false }, rows: { window: [
          { rowId: 1, kind: "userInput", turnId: "t", text: "问", origin: "realUser" },
        ] } } },
      });
      return { ack: { subscriptionId: "sub", logEpoch: "epoch", openTiming: { cliSessionRestoreMs: 12, initialFrameEncodeMs: 3, sessionRuntimeState: "cold", snapshotRowCount: 1 } } };
    }
    return {};
  };
  state.sessionId = null;
  try {
    await state.openStartupSession({ chooseResume: () => "VALID" });
    assert.equal(methods.filter((method) => method === "session/list").length, 1);
    assert.equal(client.takeStartupSessions()?.[0].sessionId, "VALID");
    assert.equal(client.takeStartupSessions(), undefined);
    assert.equal(methods.filter((method) => method === "session/read").length, 0);
    assert.equal(events.filter((event) => event.type === "transcript_sync").length, 1);
    client.endViewChange();
    assert.equal(events.filter((event) => event.type === "transcript_sync").length, 1);

    events.length = 0;
    methods.length = 0;
    await client.prepareViewChange();
    await client.switchSession("OTHER");
    assert.equal(events.filter((event) => event.type === "transcript_sync").length, 0);
    client.noteHistoryDelivered();
    client.endViewChange();
    assert.equal(events.filter((event) => event.type === "transcript_sync").length, 0);
  } finally {
    client.dispose();
  }
});

test("fresh snapshot settings skip another session read", async () => {
  const { client, state } = fixture();
  let reads = 0;
  state.sendRequest = async (method) => {
    if (method === "session/read") reads++;
    return { settings: { mode: { current: "yolo" } } };
  };
  (state as unknown as { snapshotSettingsFresh: boolean }).snapshotSettingsFresh = true;
  await client.emitSessionControls();
  assert.equal(reads, 0);
  assert.equal(state.lastControls.mode, "build");
  client.dispose();
});

test("startup consumes an explicit model catalog once and never reuses it across session generations", async () => {
  const { client, state } = fixture();
  const internal = client as unknown as { noteSnapshotCompleteness: (snapshot: unknown) => void };
  let reads = 0;
  state.sendRequest = async () => { reads++; return { settings: { model: { available: [] } } }; };
  const snapshot = { session: { model: { providerId: "test", modelId: "one" } },
    settings: { model: { available: [{ ref: { providerId: "test", modelId: "one" }, disabledReason: "disabled" }] } } };
  try {
    internal.noteSnapshotCompleteness(snapshot);
    const models = await client.readAvailableModels(true);
    assert.equal(reads, 0);
    assert.equal(models.available[0].disabledReason, "disabled");
    await client.readAvailableModels(true);
    assert.equal(reads, 1, "the snapshot catalog is only a one-shot startup optimization");
    internal.noteSnapshotCompleteness(snapshot);
    state.sessionGeneration++;
    await client.readAvailableModels(true);
    assert.equal(reads, 2, "a changed session generation invalidates the catalog");
    internal.noteSnapshotCompleteness(snapshot);
    await client.readAvailableModels();
    assert.equal(reads, 3, "an explicit model refresh still queries the backend");
    internal.noteSnapshotCompleteness({ settings: { model: { available: [] } } });
    assert.deepEqual((await client.readAvailableModels(true)).available, []);
    assert.equal(reads, 3, "an explicitly empty catalog is authoritative too");
  } finally { client.dispose(); }
});

test("initial quota refresh starts only after conversation subscription completes", async () => {
  const { client, state } = fixture();
  const subscribed = deferred<void>();
  const order: string[] = [];
  const internal = client as unknown as { startPlanQuota: () => void; ensureSessionModel: () => Promise<void> };
  state.sendRequest = async () => ({});
  internal.ensureSessionModel = async () => {};
  internal.startPlanQuota = () => { order.push("quota"); };
  state.subscribeConversation = async () => { order.push("subscribe"); await subscribed.promise; };
  try {
    const attached = state.afterSessionAttached();
    for (let i = 0; i < 10 && !order.length; i++) await Promise.resolve();
    assert.deepEqual(order, ["subscribe"]);
    subscribed.resolve();
    await attached;
    assert.deepEqual(order, ["subscribe", "quota"]);
  } finally { subscribed.resolve(); client.dispose(); }
});

test("late login resolution cannot overwrite runtime or emit model metadata after a switch", async () => {
  const events: ZCodeEvent[] = [];
  const response = deferred<null>();
  const client = new ZCodeClient({ binaryPath: "/unused", workspacePath: "/test", readDefaultModel: () => undefined, onEvent: event => events.push(event), resolveSessionRuntime: () => response.promise });
  const state = client as unknown as Internals;
  state.sessionId = "A";
  const aligning = state.alignAndEmitModel({ providerId: "test", modelId: "old-model" });
  state.sessionId = "B";
  state.sessionGeneration++;
  const runtime = { providerId: "new", modelId: "new-model" };
  state.sessionRuntime = runtime;
  response.resolve(null);
  await aligning;
  assert.strictEqual(state.sessionRuntime, runtime);
  assert.deepEqual(events, []);
  client.dispose();
});


test("queue reorder uses the v4 position of the same session", async () => {
  const { client, state } = fixture();
  state.lastLogEpoch = "epoch-A";
  state.conversationRevision = 2;
  const commands: Array<{ sessionId: string; type: string; payload: unknown }> = [];
  state.sendRequest = async (_method, params) => { commands.push(params as typeof commands[number]); return { status: "accepted", revisionAtDecision: 3 }; };
  await client.reorderQueuedMessage("queue-C", "queue-A");
  assert.deepEqual(commands.map(({ sessionId, type, payload }) => ({ sessionId, type, payload })),
    [{ sessionId: "A", type: "reorderQueueItem", payload: { queueItemId: "queue-C", beforeQueueItemId: "queue-A" } }]);
  client.dispose();
});

for (const action of ["rewind", "edit", "queue-edit", "queue-delete", "queue-now", "queue-reorder"] as const) {
  test(`${action} never retries into a newly attached session`, async () => {
    const { client, state } = fixture();
    state.lastLogEpoch = "epoch-A";
    state.conversationRevision = 1;
    const response = deferred<unknown>();
    const requests: Array<{ sessionId: string }> = [];
    state.sendRequest = async (_method, params) => { requests.push(params as { sessionId: string }); return response.promise; };
    const target = { rowId: 1, entityId: "target-A" };
    const running = action === "rewind" ? client.rewindTurnFiles(target) : action === "edit" ? client.editUserQuery(target, "updated", "preserve") : action === "queue-edit" ? client.editQueuedMessage("queue-A", "updated") : action === "queue-delete" ? client.deleteQueuedMessage("queue-A") : action === "queue-reorder" ? client.reorderQueuedMessage("queue-A", "queue-B") : client.sendQueuedNow("queue-A");
    const rejected = assert.rejects(running);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 1, "operation was not admitted before switching");
    state.sessionId = "B"; state.sessionGeneration++; state.lastLogEpoch = "epoch-B"; state.conversationRevision = 10; state.lastRevision = 10;
    response.resolve({ status: "stale", reasonCode: "proto.staleRevision", revisionAtDecision: 99 });
    await rejected;
    assert.equal(requests.length, 1);
    assert.equal(requests[0].sessionId, "A");
    assert.equal(state.lastRevision, 10);
    assert.equal(state.conversationRevision, 10);
    client.dispose();
  });
}

test("late accepted queue admission is acknowledged without changing the new session revision", async () => {
  const { client, state } = fixture();
  const response = deferred<unknown>();
  state.sendRequest = () => response.promise;
  const inserted = client.insertQueuedMessage("original", { commandId: "queue-command" });
  await new Promise(resolve => setImmediate(resolve));
  state.sessionId = "B"; state.sessionGeneration++; state.lastRevision = 10;
  response.resolve({ status: "accepted", type: "inputAccepted", revisionAtDecision: 99 });
  assert.equal(await inserted, "queue-command");
  assert.equal(state.lastRevision, 10);
  client.dispose();
});

test("ambiguous late queue response remains recoverable as an error", async () => {
  const { client, state } = fixture();
  const response = deferred<unknown>();
  state.sendRequest = () => response.promise;
  const inserted = assert.rejects(client.insertQueuedMessage("original", { commandId: "queue-command" }), /会话已切换/);
  await new Promise(resolve => setImmediate(resolve));
  state.sessionId = "B"; state.sessionGeneration++;
  response.resolve({ revisionAtDecision: 99 });
  await inserted;
  client.dispose();
});

test("late accepted queue mutation does not update the destination session revision", async () => {
  const { client, state } = fixture();
  state.lastLogEpoch = "epoch-A";
  state.conversationRevision = 3;
  const response = deferred<unknown>();
  let requestSessionId = "";
  state.sendRequest = async (_method, params) => {
    requestSessionId = (params as { sessionId: string }).sessionId;
    return response.promise;
  };
  const mutation = client.sendQueuedNow("queue-A");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requestSessionId, "A", "mutation was not admitted before switching");
  state.sessionId = "B"; state.sessionGeneration++; state.lastRevision = 10; state.conversationRevision = 10;
  response.resolve({ status: "accepted", revisionAtDecision: 99 });
  await mutation;
  assert.equal(requestSessionId, "A");
  assert.equal(state.lastRevision, 10);
  assert.equal(state.conversationRevision, 10);
  client.dispose();
});

test("stop is pending until acknowledged, and failure restores running rather than pretending completion", async () => {
  const { client, state, events } = fixture();
  const response = deferred<unknown>();
  state.sendRequest = () => response.promise;
  const rejected = assert.rejects(client.stopGeneration(), /stop failed/);
  assert.equal(state.stopping, true);
  assert.equal((events.at(-1)?.data as { status: string }).status, "stopping");
  assert.ok(!events.some(e => e.type === "status" && (e.data as { status: string }).status === "completedInterrupted"));
  response.reject(new Error("stop failed"));
  await rejected;
  assert.equal(state.stopping, false);
  assert.equal((events.at(-1)?.data as { status: string }).status, "running");
  client.dispose();
});

test("old stop acknowledgement cannot stop the newly attached session", async () => {
  const { client, state, events } = fixture();
  const response = deferred<unknown>();
  state.sendRequest = () => response.promise;
  const stopping = client.stopGeneration();
  state.sessionId = "B"; state.sessionGeneration++; state.stopping = false;
  events.length = 0;
  response.resolve({});
  await stopping;
  assert.equal(state.stopping, false);
  assert.deepEqual(events, []);
  client.dispose();
});

test("a pending stop for A does not swallow B's stop or clear B's stopping state", async () => {
  const { client, state, events } = fixture();
  const pending = [deferred<unknown>(), deferred<unknown>()];
  const requests: string[] = [];
  state.sendRequest = async (method, params) => {
    if (method === "v4/command" && (params as { type?: string }).type === "stop") {
      requests.push((params as { sessionId: string }).sessionId);
      return pending[requests.length - 1].promise;
    }
    return {};
  };
  const stopA = client.stopGeneration();
  state.sessionId = "B";
  state.sessionGeneration++;
  (client as unknown as { releaseStopWait: () => void }).releaseStopWait();
  const stopB = client.stopGeneration();
  assert.deepEqual(requests, ["A", "B"]);
  pending[0].resolve({ status: "accepted" });
  await stopA;
  assert.equal(state.stopping, true, "A's acknowledgement cleared B's stop state");
  assert.equal((events.at(-1)?.data as { sessionId?: string }).sessionId, "B");
  pending[1].resolve({ status: "accepted" });
  await stopB;
  client.dispose();
});

function projectionSnapshot(seq: number, phase: string, executionId?: string) {
  return { topic: "conversation/A", subscriptionId: "stop-sub", fromSeq: 0, toSeq: seq, payload: { kind: "snapshot", snapshot: {
    logEpoch: "epoch", seq,
    control: { phase, canStop: phase === "running", activeWorks: executionId ? [{ foregroundExecutionId: executionId }] : [] },
    rows: { window: [
      { rowId: 1, kind: "turnHeader", turnId: "turn", state: phase === "running" ? "running" : phase },
      { rowId: 2, kind: "userInput", turnId: "turn", entityId: "user-1", text: "问题" },
      { rowId: 3, kind: "assistantText", turnId: "turn", text: "正在写", state: phase === "running" ? "streaming" : "completed" },
    ], totalCount: 3 },
  } } };
}

async function attachRunningProjection(state: Internals): Promise<void> {
  state.sendRequest = async method => {
    if (method === "v4/conversation/subscribe") {
      state.handleConversationFrame(projectionSnapshot(1, "running", "fg-1"));
      return { ack: { subscriptionId: "stop-sub", logEpoch: "epoch" } };
    }
    return { status: "accepted" };
  };
  await state.subscribeConversation();
}

test("stop aborts the foreground turn and waits for the projection to interrupt", async () => {
  const { client, state, events } = fixture();
  await attachRunningProjection(state);
  const commands: Array<{ type?: string; execution?: string }> = [];
  state.sendRequest = async (method, params) => {
    const command = params as { type?: string; payload?: { expectedForegroundExecutionId?: string } };
    if (method === "v4/command") commands.push({ type: command.type, execution: command.payload?.expectedForegroundExecutionId });
    if (method === "session/stop") commands.push({ type: "session/stop" });
    return { status: "accepted" };
  };
  await client.stopGeneration();
  assert.deepEqual(commands, [{ type: "stop", execution: "fg-1" }]);
  assert.equal(state.stopping, true);
  assert.ok(!events.some(event => event.type === "status" && (event.data as { status: string }).status === "completedInterrupted"));
  state.handleConversationFrame({ topic: "conversation/A", subscriptionId: "stop-sub", fromSeq: 1, toSeq: 2, payload: { kind: "deltas", deltas: [
    { op: "state.updated", patch: { control: { phase: "running", canStop: true, activeWorks: [{ foregroundExecutionId: "fg-1" }] } } },
    { op: "row.delta", rowId: 3, path: "text", append: "更多" },
  ] } });
  const stalled = events.filter(event => event.type === "assistant_text_delta").at(-1)?.data as { streaming?: boolean; fullText?: string };
  assert.equal(stalled.streaming, false);
  assert.equal(stalled.fullText, "正在写更多");
  state.handleConversationFrame(projectionSnapshot(3, "completedInterrupted"));
  assert.equal(state.stopping, false);
  assert.equal((events.filter(event => event.type === "status").at(-1)?.data as { status: string }).status, "completedInterrupted");
  client.dispose();
});

test("a stop that does not end the turn can be sent again", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { client, state, events } = fixture();
  await attachRunningProjection(state);
  const commands: string[] = [];
  state.sendRequest = async (method, params) => {
    if (method === "v4/command") commands.push((params as { type: string }).type);
    return { status: "accepted" };
  };
  await client.stopGeneration();
  assert.equal(state.stopping, true);
  t.mock.timers.tick(1999);
  assert.equal(state.stopping, true);
  t.mock.timers.tick(1);
  await tick();
  assert.equal(state.stopping, false);
  assert.equal((events.filter(event => event.type === "status").at(-1)?.data as { status: string }).status, "running");
  await client.stopGeneration();
  assert.deepEqual(commands, ["stop", "stop"]);
  client.dispose();
});

test("editing a running turn stops that foreground turn before rewriting it", async () => {
  const { client, state } = fixture();
  await attachRunningProjection(state);
  const commands: string[] = [];
  state.sendRequest = async (method, params) => {
    const type = (params as { type?: string }).type;
    if (method === "v4/command" && type) commands.push(type);
    if (type === "stop") state.handleConversationFrame(projectionSnapshot(2, "completedInterrupted"));
    return { status: "accepted", result: { disposition: "rewind" } };
  };
  await client.editUserQuery({ rowId: 2, entityId: "user-1" }, "改过的问题", "preserve");
  assert.deepEqual(commands, ["stop", "editUserQuery"]);
  assert.equal(state.stopping, false);
  client.dispose();
});

test("an older desktop stop command falls back to session/stop", async () => {
  const { client, state } = fixture();
  const methods: string[] = [];
  state.sendRequest = async (method, params) => {
    methods.push(method);
    if ((params as { type?: string } | undefined)?.type === "stop") {
      return { status: "failed", reasonCode: "fault.command.notImplemented", message: "fault.command.notImplemented" };
    }
    return {};
  };
  await client.stopGeneration();
  assert.deepEqual(methods, ["v4/command", "session/stop"]);
  client.dispose();
});

test("current conversation snapshot and patches expose authoritative queue IDs", async () => {
  const { client, state, events } = fixture();
  state.sendRequest = async method => {
    if (method === "v4/conversation/subscribe") {
      state.handleConversationFrame({ topic: "conversation/A", subscriptionId: "queue-sub", fromSeq: 0, toSeq: 1, payload: { kind: "snapshot", snapshot: { logEpoch: "queue-epoch", seq: 1, queue: { items: [{ queueItemId: "queue_cmd", sourceCommandId: "cmd", kind: "sendText", text: "pending" }] }, rows: { window: [], totalCount: 0 } } } });
      return { ack: { subscriptionId: "queue-sub", logEpoch: "queue-epoch" } };
    }
    return {};
  };
  await state.subscribeConversation();
  assert.deepEqual((await client.loadHistory()).queue, [{ queueItemId: "queue_cmd", sourceCommandId: "cmd", kind: "sendText", text: "pending" }]);
  state.handleConversationFrame({ topic: "conversation/A", subscriptionId: "queue-sub", fromSeq: 1, toSeq: 2, payload: { kind: "deltas", deltas: [{ op: "state.updated", patch: { queue: { items: [] } } }] } });
  assert.deepEqual(client.queuedMessages(), []);
  assert.deepEqual((events.filter(e => e.type === "queue_sync").at(-1)?.data as { items: unknown[] }).items, []);
  client.dispose();
});

function resyncFixture() {
  const f = fixture();
  const snapshot = () => ({ topic: `conversation/${f.state.sessionId}`, subscriptionId: "sub", fromSeq: 0, toSeq: 5,
    payload: { kind: "snapshot", snapshot: { logEpoch: "epoch", seq: 5, rows: { window: [], totalCount: 0 } } } });
  const gap = () => f.state.handleConversationFrame({ topic: `conversation/${f.state.sessionId}`, subscriptionId: "sub", fromSeq: 7, toSeq: 9,
    payload: { kind: "deltas", deltas: [] } });
  let calls = 0;
  let fail = true;
  f.state.sendRequest = async method => {
    if (method === "v4/conversation/subscribe") {
      f.state.handleConversationFrame(snapshot()); return { ack: { subscriptionId: "sub" } };
    }
    if (method === "v4/conversation/resync") {
      calls++;
      if (fail) throw new Error("server unavailable");
      f.state.handleConversationFrame(snapshot()); return {};
    }
    return {};
  };
  return { ...f, gap, snapshot, calls: () => calls, recover: () => { fail = false; } };
}

test("failed resync backs off, retries without incoming frames, and resets after recovery", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = resyncFixture();
  try {
    await f.state.subscribeConversation(); f.gap(); await tick();
    assert.equal(f.calls(), 1);
    for (let i = 0; i < 30; i++) f.gap();
    await tick(); assert.equal(f.calls(), 1);
    t.mock.timers.tick(999); await tick(); assert.equal(f.calls(), 1);
    t.mock.timers.tick(1); await tick(); assert.equal(f.calls(), 2);
    assert.equal(f.events.filter(e => e.type === "session_error").length, 1);
    t.mock.timers.tick(1999); await tick(); assert.equal(f.calls(), 2);
    f.recover(); t.mock.timers.tick(1); await tick(); assert.equal(f.calls(), 3);
    f.gap(); await tick(); assert.equal(f.calls(), 4);
  } finally { f.client.dispose(); }
});

for (const change of ["switch", "dispose", "snapshot"]) {
  test(`pending resync retry is cancelled by ${change}`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = resyncFixture();
    try {
      await f.state.subscribeConversation(); f.gap(); await tick();
      assert.equal(f.calls(), 1);
      if (change === "switch") { f.state.sessionId = "B"; await f.state.subscribeConversation(); }
      else if (change === "dispose") f.client.dispose();
      else f.state.handleConversationFrame(f.snapshot());
      t.mock.timers.tick(30_000); await tick(); assert.equal(f.calls(), 1);
    } finally { f.client.dispose(); }
  });
}

test("Linux session listing makes one scoped request and excludes other workspace casing", async () => {
  const {client, state} = fixture();
  let calls = 0;
  state.sendRequest = async (method, params) => {
    assert.equal(method, "session/list"); calls++;
    assert.deepEqual(params, {workspace: {workspaceKey: "/test", workspacePath: "/test"}, includeArchived: true, limit: 80});
    return {sessions: [
      {sessionId: "ours", workspace: {workspacePath: "/test"}},
      {sessionId: "other", workspace: {workspacePath: "/Test"}},
    ]};
  };
  assert.deepEqual((await client.listSessions(true)).map(s => s.sessionId), ["ours"]);
  assert.equal(calls, 1);
});

test("session pages expand past eighty entries and report whether the raw page is complete", async () => {
  const { client, state } = fixture();
  const all = Array.from({ length: 81 }, (_, index) => ({ sessionId: `session-${index}`, updatedAt: index }));
  const limits: number[] = [];
  state.sendRequest = async (method, params) => {
    assert.equal(method, "session/list");
    const { limit } = params as { limit: number };
    limits.push(limit);
    return { sessions: all.slice(0, limit) };
  };
  try {
    const first = await client.listSessionsPage(true);
    assert.equal(first.sessions.length, 80);
    assert.equal(first.hasMore, true);
    const expanded = await client.listSessionsPage(true, 160);
    assert.equal(expanded.sessions.length, 81);
    assert.equal(expanded.sessions[0].sessionId, "session-80");
    assert.equal(expanded.hasMore, false);
    assert.deepEqual(limits, [80, 160]);
  } finally { client.dispose(); }
});

test("Windows page truncation survives deduplication across workspace path variants", t => {
  const home = isolatedHome(t);
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
  const cliPath = path.join(home, ".zcode/cli/db/db.sqlite");
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void };
  };
  const db = new DatabaseSync(cliPath);
  db.exec("CREATE TABLE session (directory TEXT); INSERT INTO session VALUES ('c:/work/')");
  db.close();
  const client = new ZCodeClient({ binaryPath: "/unused", workspacePath: "C:\\Work", onEvent() {} });
  const state = client as unknown as Internals;
  let calls = 0;
  state.sendRequest = async (method, params) => {
    assert.equal(method, "session/list");
    const request = params as { workspace: { workspacePath: string }; limit: number };
    assert.equal(request.limit, 3); calls++;
    return { sessions: Array.from({ length: 3 }, (_, index) => ({
      sessionId: "same", updatedAt: index,
      workspace: { workspacePath: request.workspace.workspacePath },
    })) };
  };
  return client.listSessionsPage(true, 3).then(page => {
    assert.equal(calls, 2);
    assert.equal(page.sessions.length, 1);
    assert.equal(page.sessions[0].updatedAt, 2);
    assert.equal(page.hasMore, true);
  }).finally(() => client.dispose());
});

test("session page compatibility fallback preserves the requested limit", async () => {
  const { client, state } = fixture();
  const requests: Array<{ limit: number; includeArchived?: boolean }> = [];
  state.sendRequest = async (_method, params) => {
    const request = params as { limit: number; includeArchived?: boolean };
    requests.push(request);
    if (Object.hasOwn(request, "includeArchived")) throw new Error('ZCode error -32602: Unrecognized key: "includeArchived"');
    return { sessions: [{ sessionId: "active" }] };
  };
  try {
    assert.equal((await client.listSessionsPage(true, 160)).hasMore, false);
    await client.listSessionsPage(false, 320);
    assert.deepEqual(requests.map(request => request.limit), [160, 160, 320]);
    assert.equal(Object.hasOwn(requests[1], "includeArchived"), false);
    assert.equal(Object.hasOwn(requests[2], "includeArchived"), false);
  } finally { client.dispose(); }
});

test("a failed session page remains a failure rather than a complete empty page", async () => {
  const { client, state } = fixture();
  state.sendRequest = async () => { throw new Error("page unavailable"); };
  try { await assert.rejects(client.listSessionsPage(true, 160), /page unavailable/); }
  finally { client.dispose(); }
});

test("session pages reject invalid limits before making requests", async () => {
  const { client, state } = fixture();
  let calls = 0;
  state.sendRequest = async () => { calls++; return {}; };
  try {
    for (const limit of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(client.listSessionsPage(true, limit), RangeError);
    }
    assert.equal(calls, 0);
  } finally { client.dispose(); }
});

test("session listing retries without includeArchived on Desktop 3.16.2 and remembers the capability", async () => {
  const { client, state } = fixture();
  const requests: unknown[] = [];
  state.sendRequest = async (method, params) => {
    assert.equal(method, "session/list");
    requests.push(params);
    if (Object.hasOwn(params as object, "includeArchived")) {
      throw new Error('ZCode error -32602: Invalid params — (root): Unrecognized key: "includeArchived"');
    }
    return { sessions: [
      { sessionId: "active", workspace: { workspacePath: "/test" } },
      { sessionId: "archived", archivedAt: 10, workspace: { workspacePath: "/test" } },
      { sessionId: "other", workspace: { workspacePath: "/other" } },
    ] };
  };
  assert.deepEqual((await client.listSessions(true)).map(s => s.sessionId), ["active", "archived"]);
  assert.deepEqual((await client.listSessions()).map(s => s.sessionId), ["active"]);
  assert.equal(requests.length, 3);
  assert.equal(Object.hasOwn(requests[0] as object, "includeArchived"), true);
  for (const params of requests.slice(1)) {
    assert.deepEqual(params, { workspace: { workspaceKey: "/test", workspacePath: "/test" }, limit: 80 });
  }
});

test("session listing does not retry unrelated failures or hide a failed fallback", async () => {
  for (const message of [
    'ZCode error -32602: Invalid params — Unrecognized key: "limit"',
    "ZCode error 401: Unauthorized",
    "Request session/list timed out after 20000ms",
  ]) {
    const { client, state } = fixture();
    let calls = 0;
    state.sendRequest = async () => { calls++; throw new Error(message); };
    await assert.rejects(client.listSessions(true), error => (error as Error).message === message);
    assert.equal(calls, 1);
  }
  const { client, state } = fixture();
  let calls = 0;
  state.sendRequest = async () => {
    if (++calls === 1) throw new Error('ZCode error -32602: Unrecognized key: "includeArchived"');
    throw new Error("fallback failed");
  };
  await assert.rejects(client.listSessions(true), /fallback failed/);
  assert.equal(calls, 2);
});

test("image-only send uses desktop v4 metadata and keeps the original session", async () => {
  const {client,state}=fixture(); state.ensureSessionModel=async()=>{};
  const requests:Array<{method:string;params:any}>=[];
  state.sendRequest=async(method,params)=>{requests.push({method,params});return {status:"accepted"};};
  const image={ref:"attachment-ref",fileName:"image.png",mime:"image/png",bytes:70};
  await client.sendMessage("",[image]);
  const request=requests.find(request=>request.method==="v4/command")!;
  assert.ok(request); assert.equal(request.params.sessionId,"A");
  assert.deepEqual(request.params.payload,{text:"",attachments:[image],requestedDelivery:"startNow"});
  assert.ok(!requests.some(request=>request.method==="session/send"));
});
test("image previews validate chunks and never assume attachment index zero", async () => {
  const {client,state}=fixture();
  const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGMM6LnDgA0wYRUdtBIAWtsByEY277MAAAAASUVORK5CYII=","base64");
  const image={ref:"second-image",fileName:"image.png",mime:"image/png",bytes:png.length};
  let expectedIndex: number | undefined;
  state.sendRequest=async(method,params)=>{
    assert.equal(method,"v4/attachment/read");const p=params as Record<string,unknown>;
    assert.equal(p.sessionId,"B");assert.equal(p.ref,"second-image"); assert.equal(p.attachmentIndex,expectedIndex);
    if (expectedIndex !== undefined) assert.deepEqual(p.target,{rowId:7,entityId:"user-B"});
    const offset=Number(p.offset),end=Math.min(png.length,offset+20);
    return {dataBase64:png.subarray(offset,end).toString("base64"),totalBytes:png.length,mediaType:"image/png",nextOffset:end===png.length?null:end};
  };
  assert.deepEqual(await client.readImage(image,"B"),png);
  expectedIndex = 1;
  assert.deepEqual(await client.readImage(image,"B",{target:{rowId:7,entityId:"user-B"},attachmentIndex:1}),png);
  state.sendRequest=async()=>({dataBase64:"not valid",totalBytes:png.length,mediaType:"image/png",nextOffset:null});
  await assert.rejects(client.readImage(image,"B"));
});

test("initial thought-level metadata without enabled activates picker and mode-only snapshots preserve it", () => {
 const {state}=fixture();
 state.adoptControlsFromPatch({thoughtLevel:{current:"high",available:[{value:"low"},{value:"high"}]}});
 assert.equal(state.lastControls.thoughtEnabled,true);
 state.applySnapshotSettings({settings:{mode:{current:"build"}}});
 assert.equal(state.lastControls.thoughtEnabled,true);assert.equal(state.lastControls.thoughtLevels.length,2);
 state.applySnapshotSettings({settings:{thoughtLevel:{enabled:false}}});assert.equal(state.lastControls.thoughtEnabled,false);
 state.adoptControlsFromPatch({thoughtLevel:{available:[]}});assert.equal(state.lastControls.thoughtLevels.length,0);assert.equal(state.lastControls.thoughtEnabled,false);
 state.applySnapshotSettings({settings:{thoughtLevel:{available:[{value:"high"}],current:"high"}}});assert.equal(state.lastControls.thoughtEnabled,true);
});

test("new session initializes a model advertised by the workspace registry and exposes its reasoning controls", async () => {
    const {client,state,events}=fixture();
    const runtime = {providerId:"configured",providerName:"Test",modelId:"working",kind:"openai",baseURL:"http://localhost",apiKey:"test-only",models:{},source:"custom-provider" as const};
    client.setDefaultRuntime(runtime);
    state.subscribeConversation=async()=>{};
    let selected=false;
    const requests:string[]=[];
    state.sendRequest=async(method,params)=>{
      requests.push(method);
      if(method==="session/create"){state.sessionId="NEW";return {};}
      if(method==="session/subscribe")return {snapshot:{settings:{model:{available:[{ref:{providerId:"configured",modelId:"working"}}]},thoughtLevel:{enabled:false,available:[]}}}};
      if(method==="v4/command"){
        const command=params as {type:string;payload:{provider:string;model:string}};
        assert.equal(command.type,"switchModelConfig");assert.equal(command.payload.provider,"configured");assert.equal(command.payload.model,"working");
        selected=true;return {status:"accepted",revisionAtDecision:5};
      }
      if(method==="session/read")return {settings:{model:{current:{providerId:"configured",modelId:"working"}},thoughtLevel:{enabled:true,current:"max",available:[{value:"max",label:"Max"}]}}};
      if(method==="session/send"){assert.ok(selected,"send reached server before model selection");return {};}
      return {};
    };
    try {
      await client.newSession();
      assert.ok(state.liveModelReady);
      assert.equal(state.lastControls.thoughtEnabled,true);
      assert.equal(state.lastControls.thoughtLevel,"max");
      assert.ok(events.some(event=>event.type==="session_ready"));
      await client.sendMessage("FIRST_MESSAGE");
      assert.equal(requests.filter(method=>method==="v4/command").length,1);
      assert.equal(requests.filter(method=>method==="session/send").length,1);
    } finally {client.dispose();}
  });

test("new session cannot announce readiness after its configured model is rejected", async()=>{
  const {client,state,events}=fixture();
  client.setDefaultRuntime({providerId:"test",providerName:"Test",modelId:"unavailable",kind:"openai",baseURL:"http://localhost",apiKey:"test-only",models:{},source:"custom-provider"});
  let attachedForRecovery=false;
  state.subscribeConversation=async()=>{attachedForRecovery=true;};
  state.sendRequest=async method=>{
    if(method==="session/create"){state.sessionId="NEW";return {};}
    if(method==="session/subscribe" || method==="session/read")return {settings:{model:{available:[{ref:{providerId:"test",modelId:"unavailable"}}]}},snapshot:{settings:{model:{available:[{ref:{providerId:"test",modelId:"unavailable"}}]}}}};
    if(method==="v4/command")return {status:"rejected",message:"MODEL_UNAVAILABLE"};
    return {};
  };
  try {await assert.rejects(client.newSession(),/MODEL_UNAVAILABLE/);assert.equal(state.liveModelReady,false);assert.ok(attachedForRecovery);assert.ok(!events.some(event=>event.type==="session_ready"));}
  finally {client.dispose();}
});

test("new-session defaults apply model before model-specific reasoning and before readiness", async () => {
  const { client, state, events } = fixture();
  const base = { providerId: "base-provider", modelId: "base-model" };
  const preferred = { providerId: "preferred-provider", modelId: "preferred-model" };
  let current = base;
  let currentMode = "build";
  let thought: string | undefined;
  const commands: string[] = [];
  const snapshot = () => ({
    session: { model: current },
    settings: {
      model: { current, available: [{ ref: base }, { ref: preferred }] },
      mode: { current: currentMode },
      thoughtLevel: current.providerId === preferred.providerId
        ? { enabled: true, current: thought ?? "medium", available: [{ value: "medium" }, { value: "high" }] }
        : { enabled: true, current: "low", available: [{ value: "low" }] },
    },
  });
  state.subscribeConversation = async () => {};
  state.sendRequest = async (method, params) => {
    if (method === "session/create") { assert.equal((params as { mode: string }).mode, "yolo", "create with the requested permission before indexing the empty identity"); state.sessionId = "NEW_DEFAULTS"; return {}; }
    if (method === "session/subscribe") return { snapshot: snapshot() };
    if (method === "session/read") return snapshot();
    if (method === "v4/command") {
      const payload = (params as { payload: { provider: string; model: string; thought: string } }).payload;
      assert.deepEqual(payload, { provider: preferred.providerId, model: preferred.modelId, thought: "low" });
      current = preferred;
      commands.push("model");
      return { status: "accepted" };
    }
    if (method === "session/setMode") { currentMode = "yolo"; commands.push("mode"); return {}; }
    if (method === "session/setThoughtLevel") {
      thought = (params as { thoughtLevel: string }).thoughtLevel;
      commands.push("thought");
      return {};
    }
    return {};
  };
  const defaults: NewSessionDefaults = { model: preferred, mode: "yolo", thoughtLevel: "high" };
  try {
    await client.newSession(defaults);
    assert.deepEqual(commands, ["model", "mode", "thought"], JSON.stringify({
      warnings: events.filter(event => event.type === "session_defaults_warning").map(event => event.data),
      sessionModel: state.sessionRuntime,
      controls: state.lastControls,
    }));
    assert.equal(thought, "high");
    const ready = events.findIndex(event => event.type === "session_ready");
    const applied = events.findIndex(event => event.type === "session_controls"
      && (event.data as SessionControls).mode === "yolo"
      && (event.data as SessionControls).thoughtLevel === "high");
    assert.ok(ready > 0 && ready > applied, "the new session is announced only after defaults are applied");
    assert.ok(!events.some(event => event.type === "session_defaults_warning"));
  } finally { client.dispose(); }
});

for (const preferred of [
  { providerId: "deepseek", modelId: "deepseek-flash" },
  { providerId: "custom-openai-compatible", modelId: "chat-model" },
  { providerId: "custom-anthropic-compatible", modelId: "reasoning-model" },
]) {
test(`new-session defaults select ${preferred.providerId} models omitted from the session snapshot`, async () => {
  const resolvedModels: string[] = [];
  const { client, state, events } = fixture(undefined, async model => {
    if (model.providerId !== preferred.providerId || model.modelId !== preferred.modelId) return null;
    resolvedModels.push(`${model.providerId}/${model.modelId}`);
    return {
      providerId: model.providerId,
      providerName: model.providerId,
      modelId: model.modelId,
      kind: "openai",
      baseURL: "http://localhost",
      apiKey: "test-only-key",
      models: {},
      source: "custom-provider",
    };
  });
  const base = { providerId: "account:default", modelId: "base-model" };
  let current = base;
  const commands: Array<{ provider: string; model: string; thought: string }> = [];
  const snapshot = () => ({
    session: { model: current },
    settings: {
      // The desktop/provider picker can offer configured models that this
      // newly-created session has not yet listed in its workspace snapshot.
      model: { current, available: [{ ref: base }] },
      mode: { current: "build" },
      thoughtLevel: { enabled: false, available: [] },
    },
  });
  state.subscribeConversation = async () => {};
  state.sendRequest = async (method, params) => {
    if (method === "session/create") { state.sessionId = "NEW_DEEPSEEK_DEFAULT"; return {}; }
    if (method === "session/subscribe") return { snapshot: snapshot() };
    if (method === "session/read") return snapshot();
    if (method === "v4/command") {
      const payload = (params as { payload: { provider: string; model: string; thought: string } }).payload;
      commands.push(payload);
      assert.deepEqual(payload, { provider: preferred.providerId, model: preferred.modelId, thought: "max" });
      current = preferred;
      return { status: "accepted" };
    }
    return {};
  };

  try {
    await client.newSession({ model: preferred });
    assert.deepEqual(commands, [{ provider: preferred.providerId, model: preferred.modelId, thought: "max" }]);
    assert.ok(resolvedModels.length > 0, "the selected provider is resolved through the same generic runtime path");
    assert.deepEqual(state.sessionRuntime, {
      providerId: preferred.providerId,
      providerName: preferred.providerId,
      modelId: preferred.modelId,
      kind: "openai",
      baseURL: "http://localhost",
      apiKey: "test-only-key",
      models: {},
      source: "custom-provider",
    });
    assert.ok(events.some(event => event.type === "session_ready"));
    assert.ok(!events.some(event => event.type === "session_defaults_warning"));
  } finally { client.dispose(); }
});
}

test("unsupported new-session reasoning default falls back without failing session creation", async () => {
  const { client, state, events } = fixture();
  let thoughtWrites = 0;
  const snapshot = {
    session: { model: { providerId: "provider", modelId: "model" } },
    settings: {
      model: { current: { providerId: "provider", modelId: "model" }, available: [{ ref: { providerId: "provider", modelId: "model" } }] },
      mode: { current: "build" },
      thoughtLevel: { enabled: false, available: [] },
    },
  };
  state.subscribeConversation = async () => {};
  state.sendRequest = async method => {
    if (method === "session/create") { state.sessionId = "NEW_UNSUPPORTED_THOUGHT"; return {}; }
    if (method === "session/subscribe") return { snapshot };
    if (method === "session/read") return snapshot;
    if (method === "session/setThoughtLevel") { thoughtWrites++; return {}; }
    return {};
  };
  try {
    await client.newSession({ thoughtLevel: "max" });
    assert.equal(thoughtWrites, 0);
    assert.ok(events.some(event => event.type === "session_ready"));
    assert.ok(events.some(event => event.type === "session_defaults_warning"
      && (event.data as { message: string }).message.includes("所选模型不支持")));
  } finally { client.dispose(); }
});

test("release after a failed new attachment never replays the previous conversation into the new session",async()=>{
  const {client,state,events}=fixture();
  state.sendRequest=async()=>{
    state.handleConversationFrame({topic:"conversation/A",subscriptionId:"old",fromSeq:0,toSeq:1,payload:{kind:"snapshot",snapshot:{logEpoch:"old-epoch",seq:1,rows:{window:[{rowId:1,kind:"assistantText",turnId:"old-turn",text:"OLD_PRIVATE_ANSWER",state:"complete"}]}}}});
    return {ack:{subscriptionId:"old"}};
  };
  try{
    await state.subscribeConversation();await client.prepareViewChange();state.sessionId="NEW";state.sessionGeneration++;
    const count=events.length;client.endViewChange();
    assert.ok(!events.slice(count).some(event=>event.type==="transcript_sync"));
  }finally{client.dispose();}
});

for (const current of [true, false]) {
  test(`new account session uses workspace registry instead of absent builtin provider (${current ? "current" : "available"})`, async () => {
    const {client,state,events}=fixture();
    client.setDefaultRuntime({providerId:"builtin:bigmodel-coding-plan",providerName:"Test",modelId:"GLM-5.3-Flash",kind:"openai",baseURL:"http://localhost",apiKey:"test-only",models:{},source:"custom-provider"});
    const registered={providerId:"account:bigmodel-team-coding-plan",modelId:"GLM-5.3-Flash"};
    let selected=current;
    state.subscribeConversation=async()=>{};
    state.sendRequest=async(method,params)=>{
      const snapshot={settings:{model:{current:selected?registered:undefined,available:[{ref:registered}]},thoughtLevel:{enabled:true,current:"high",available:[{value:"high"}]}}};
      if(method==="session/create"){state.sessionId="NEW";return {};}
      if(method==="session/subscribe")return {snapshot};
      if(method==="session/read")return snapshot;
      if(method==="v4/command"){
        const command=params as {payload:{provider:string;model:string}};
        assert.equal(command.payload.provider,registered.providerId);
        assert.equal(command.payload.model,registered.modelId);
        selected=true;return {status:"accepted"};
      }
      if(method==="session/send"){assert.ok(selected);return {};}
      return {};
    };
    try {
      await client.newSession();await client.sendMessage("FIRST_ACCOUNT_MESSAGE");
      assert.ok(state.liveModelReady);assert.ok(events.some(e=>e.type==="session_ready"));
      assert.equal(state.lastControls.thoughtEnabled,true);
    }finally{client.dispose();}
  });
}

test("cold new session can bootstrap its model on first send instead of rejecting its empty catalog",async()=>{
 const {client,state,events}=fixture();
 client.setDefaultRuntime({providerId:"builtin:missing",providerName:"Legacy",modelId:"test",kind:"openai",baseURL:"http://localhost",apiKey:"test-only",models:{},source:"custom-provider"});
 state.subscribeConversation=async()=>{};let sent=false;
 state.sendRequest=async(method)=>{
  if(method==="session/create"){state.sessionId="COLD";return {};}
  const snapshot={settings:{model:{available:[],current:sent?{providerId:"account:registered",modelId:"test"}:undefined},thoughtLevel:{enabled:false,available:[]}}};
  if(method==="session/subscribe")return {snapshot};
  if(method==="session/read")return snapshot;
  if(method==="v4/command")assert.fail("must not configure an unregistered legacy provider");
  if(method==="session/send"){sent=true;return {};}
  return {};
 };
 try{await client.newSession();assert.ok(events.some(event=>event.type==="session_ready"));await client.sendMessage("COLD_FIRST_SEND");assert.ok(sent);await state.ensureSessionModel();assert.ok(state.liveModelReady);}
 finally{client.dispose();}
});

test("cold session uses the CLI account default after creation, never the login metadata alias",async()=>{
 const account={providerId:"account:bigmodel-team-coding-plan",modelId:"GLM-5.3-Flash"};
 const {client,state}=fixture(account);let configured=false;
 client.setDefaultRuntime({providerId:"builtin:bigmodel-coding-plan",providerName:"Legacy",modelId:account.modelId,kind:"openai",baseURL:"http://localhost",apiKey:"test-only",models:{},source:"custom-provider"});
 state.subscribeConversation=async()=>{};
 state.sendRequest=async(method,params)=>{
  if(method==="session/create"){state.sessionId="COLD_ACCOUNT";return {};}
  const snapshot={settings:{model:{available:[],current:configured?account:undefined}}};
  if(method==="session/subscribe")return {snapshot};if(method==="session/read")return snapshot;
  if(method==="v4/command"){assert.deepEqual((params as {payload:{provider:string;model:string;thought:string}}).payload,{provider:account.providerId,model:account.modelId,thought:"max"});configured=true;return {status:"accepted"};}
  if(method==="session/send"){assert.ok(configured);return {};}
  return {};
 };
 try{await client.newSession();assert.ok(configured);await client.sendMessage("ACCOUNT_FIRST_SEND");assert.ok(configured);}
 finally{client.dispose();}
});

for (const accepted of [true,false]) {
 test(`regular send uses the attached v4 replica and never duplicates a ${accepted?"successful":"rejected"} submission through legacy RPC`,async()=>{
  const {client,state}=fixture();
  state.sendRequest=async(method)=>{
   state.handleConversationFrame({topic:"conversation/A",subscriptionId:"send-v4",fromSeq:0,toSeq:1,payload:{kind:"snapshot",snapshot:{logEpoch:"send-v4",seq:1,rows:{window:[]}}}});
   return {ack:{subscriptionId:"send-v4"}};
  };
  try{
   await state.subscribeConversation();state.liveModelReady=true;
   const calls:Array<{method:string;params:unknown}>=[];
   state.sendRequest=async(method,params)=>{calls.push({method,params});return accepted?{status:"accepted"}:{status:"rejected",message:"SEND_NOT_ALLOWED"};};
   if(accepted)await client.sendMessage("REGULAR_V4_TEXT");else await assert.rejects(client.sendMessage("REGULAR_V4_TEXT"),/SEND_NOT_ALLOWED/);
   assert.equal(calls.length,1);assert.equal(calls[0].method,"v4/command");
   const command=calls[0].params as {sessionId:string;type:string;payload:unknown};
   assert.equal(command.sessionId,"A");assert.equal(command.type,"sendText");assert.deepEqual(command.payload,{text:"REGULAR_V4_TEXT",requestedDelivery:"startNow"});
  }finally{client.dispose();}
 });
}

test("submitting /goal uses the desktop goal command instead of a normal prompt", async () => {
  const { client, state } = fixture();
  state.sendRequest = async (method) => {
    state.handleConversationFrame({ topic: "conversation/A", subscriptionId: "goal-v4", fromSeq: 0, toSeq: 1, payload: { kind: "snapshot", snapshot: { logEpoch: "goal-v4", seq: 1, rows: { window: [] } } } });
    return { ack: { subscriptionId: "goal-v4" } };
  };
  try {
    await state.subscribeConversation();
    state.liveModelReady = true;
    const calls: Array<{ method: string; params: { type?: string; payload?: unknown; sessionId?: string } }> = [];
    state.sendRequest = async (method, params) => {
      calls.push({ method, params: params as { type?: string; payload?: unknown; sessionId?: string } });
      return { status: "accepted" };
    };
    await client.sendMessage("/goal 发布 1.5 版本");
    await client.insertQueuedMessage("/goal pause", { commandId: "pause-1" });
    await client.insertQueuedMessage("/goal clear", { commandId: "clear-1" });
    assert.deepEqual(calls.map(call => call.method), ["v4/command", "v4/command", "session/goal"]);
    assert.equal(calls[0].params.type, "sendGoalCommand");
    assert.deepEqual(calls[0].params.payload, { text: "发布 1.5 版本", displayText: "/goal 发布 1.5 版本" });
    assert.equal(calls[1].params.type, "pauseGoal");
    assert.deepEqual(calls[1].params.payload, {});
    assert.equal(typeof (calls[1].params as { baseRevision?: unknown }).baseRevision, "number");
    assert.equal(calls[2].params.sessionId, "A");
    assert.deepEqual(calls[2].params, { sessionId: "A", inputId: "clear-1", action: "clear" });
  } finally { client.dispose(); }
});


test("new sessions do not inherit plan or full-access controls, while switching back preserves session state", async () => {
  const {client,state} = fixture();
  state.sendRequest = async method => method === "session/list" ? {sessions:[]} : {};
  await client.setMode("yolo"); await client.setMode("plan");
  state.afterSessionAttached = async () => {};
  state.adoptResumedModel = async () => {};
  await state.createSession(false);
  assert.equal(client.currentMode(),"build");
  assert.equal(state.lastControls.baseMode,"build");
  await client.resumeSession("B");
  assert.equal(client.currentMode(),"build");
  state.applySnapshotSettings({settings:{mode:{current:"edit"}}});
  await client.resumeSession("A");
  assert.equal(client.currentMode(),"plan");
  assert.equal(state.lastControls.baseMode,"yolo");
  await client.resumeSession("B");
  assert.equal(client.currentMode(),"edit");
  client.dispose();
});

test("nested settings still apply when an outer control patch changes plan state", () => {
  const {client,state} = fixture();
  state.adoptControlsFromPatch({planEnabled:true,settings:{mode:{current:"edit"},planEnabled:false}});
  assert.equal(state.lastControls.planEnabled,false);
  assert.equal(state.lastControls.baseMode,"edit");
  client.dispose();
});


test("history delivery tracks the projected version, including an update before posting the loaded page", async () => {
  const {client,state,events} = fixture();
  const projection = client as unknown as {replica:ConversationReplica;handleConversationFrame:(frame:unknown)=>void};
  projection.replica = new ConversationReplica("conversation/A", "sub");
  const snapshot = (seq:number,text:string) => ({topic:"conversation/A",subscriptionId:"sub",fromSeq:0,toSeq:seq,
    payload:{kind:"snapshot",snapshot:{logEpoch:"epoch",seq,control:{phase:"draft",canStop:false},
      rows:{window:[{rowId:1,kind:"assistantText",turnId:"t",text,state:"complete"}]}}}});
  try {
    await client.prepareViewChange();
    projection.handleConversationFrame(snapshot(1,"OLD"));
    const old = await client.loadHistory();
    projection.handleConversationFrame(snapshot(2,"NEW"));
    client.noteHistoryDelivered(old.items);
    assert.equal(client.historyDelivered("A"),false);
    events.length=0;
    client.endViewChange();
    const published = events.filter(event=>event.type === "transcript_sync");
    assert.equal(published.length,1);
    const data=published[0].data as {items:HistoryItem[]};
    assert.equal(data.items[0].text,"NEW");
    client.noteHistoryDelivered(data.items);
    assert.equal(client.historyDelivered("A"),true);
    await client.prepareViewChange();
    projection.handleConversationFrame(snapshot(2,"CORRECTED"));
    assert.equal(client.historyDelivered("A"),false);
    client.noteHistoryDelivered((await client.loadHistory()).items);
    await client.prepareViewChange();events.length=0;client.endViewChange();
    assert.equal(events.filter(event=>event.type === "transcript_sync").length,0);
  } finally {client.dispose();}
});

for (const failed of [false,true]) {
  test(`401 invalidates runtime auth and ${failed ? "a failed refresh cannot fall back to the expired key" : "a refreshed key is reused"}`, async () => {
    let reads=0;const replies:Array<{result:{headersApplied:boolean;requestAuth?:{apiKey:string}}}>=[];
    const runtime:ResolvedRuntime={providerId:"prov",providerName:"Test",modelId:"m",kind:"openai",baseURL:"http://localhost",apiKey:"expired-test-key",models:{},source:"desktop-apikey"};
    const client=new ZCodeClient({binaryPath:"/unused",workspacePath:"/test",runtime,onEvent:()=>{},
      resolveProviderAuth:async()=>{reads++;if(failed)throw new Error("refresh failed");return {apiKey:"fresh-test-key"};}});
    const state=client as unknown as {loginStale:boolean;pending:Map<number,unknown>;write:(reply:unknown)=>void;handleLine:(line:string)=>void;handleProviderRuntimeHeaders:(id:number,params:unknown)=>Promise<void>};
    state.write=reply=>replies.push(reply as typeof replies[number]);
    state.pending.set(9,{resolve:()=>{},reject:()=>{}});
    state.handleLine(JSON.stringify({id:9,error:{code:401,message:"Unauthorized"}}));
    assert.equal(state.loginStale,true);
    try {
      await state.handleProviderRuntimeHeaders(10,{providerId:"prov"});
      assert.equal(reads,1);
      assert.equal(replies[0].result.headersApplied,!failed);
      assert.notEqual(replies[0].result.requestAuth?.apiKey,"expired-test-key");
      if(!failed){await state.handleProviderRuntimeHeaders(11,{providerId:"prov"});assert.equal(reads,1);assert.equal(replies[1].result.requestAuth?.apiKey,"fresh-test-key");}
    } finally {client.dispose();}
  });
}

test("settled startup login cannot reinstall its old key after invalidation", async () => {
  const runtime:ResolvedRuntime={providerId:"prov",providerName:"Test",modelId:"m",kind:"openai",baseURL:"http://localhost",apiKey:"old-test-key",models:{},source:"desktop-apikey"};
  const client=new ZCodeClient({binaryPath:"/unused",workspacePath:"/test",onEvent:()=>{},pendingLogin:Promise.resolve({ok:true,runtime,picker:[]})});
  const state=client as unknown as {awaitStartupLogin:()=>Promise<void>;sessionRuntime:ResolvedRuntime|null;defaultRuntime:ResolvedRuntime|null;loginStale:boolean};
  try {
    await state.awaitStartupLogin();assert.equal(state.sessionRuntime?.apiKey,"old-test-key");
    state.sessionRuntime=null;state.defaultRuntime=null;state.loginStale=true;
    await state.awaitStartupLogin();assert.equal(state.sessionRuntime,null);assert.equal(state.defaultRuntime,null);
  } finally {client.dispose();}
});

for (const scenario of ["current", "advanced", "wrong-owner", "legacy", "partial"] as const) {
  test(`initial model selection reuses only a current attached catalog (${scenario})`, async () => {
    const validated: string[] = [];
    const { client, state } = fixture(undefined, async model => {
      validated.push(model.modelId);
      return null;
    });
    state.lastRevision = 5;
    const snapshot = {
      session: { sessionId: "A" }, runtime: { stateRevision: 5 },
      settings: { model: { available: [{ ref: { providerId: "prov", modelId: "attached" } }] } },
    };
    const supplied: unknown = scenario === "wrong-owner" ? { ...snapshot, session: { sessionId: "B" } }
      : scenario === "legacy" ? { ...snapshot, runtime: {} }
      : scenario === "partial" ? { ...snapshot, settings: {} } : snapshot;
    if (scenario === "advanced") state.lastRevision = 6;
    let reads = 0;
    const selected: string[] = [];
    state.sendRequest = async method => {
      assert.equal(method, "session/read");
      reads++;
      return { settings: { model: { available: [{ ref: { providerId: "prov", modelId: "fresh" } }] } } };
    };
    state.setModel = async (_provider, model) => { selected.push(model); };
    try {
      await state.ensureSessionModel(supplied);
      assert.equal(reads, scenario === "current" ? 0 : 1);
      assert.deepEqual(selected, [scenario === "current" ? "attached" : "fresh"]);
      assert.deepEqual(validated, selected, "reusing a catalog must still validate the desktop provider");
    } finally { client.dispose(); }
  });
}

test("resuming an unset model uses the subscribed catalog without another snapshot read", async () => {
  const { client, state } = fixture();
  const model = { providerId: "prov", modelId: "m1" };
  const snapshot = { session: { sessionId: "A" }, runtime: { stateRevision: 5, eventSeq: 7 },
    settings: { model: { available: [{ ref: model }] } } };
  state.subscribeConversation = async () => {};
  client.emitSessionControls = async () => client.confirmedControls();
  const selected: string[] = [];
  state.setModel = async (_provider, model) => { selected.push(model); state.liveModelReady = true; };
  state.sendRequest = async method => {
    if (method === "session/resume") return snapshot;
    if (method === "session/subscribe") return { eventSeq: 7 };
    if (method === "session/read") assert.fail("an unchanged attached catalog was read again");
    return {};
  };
  try {
    await client.resumeSession("A", { sessionId: "A", title: "Empty", updatedAt: 1 });
    assert.deepEqual(selected, [model.modelId]);
  } finally { client.dispose(); }
});

test("an attached catalog cannot revive a model rejected by the desktop inventory", async () => {
  const { client, state } = fixture(undefined, async () => false);
  state.lastRevision = 5;
  const snapshot = { session: { sessionId: "A" }, runtime: { stateRevision: 5 },
    settings: { model: { available: [{ ref: { providerId: "prov", modelId: "removed" } }] } } };
  let reads = 0;
  state.sendRequest = async method => {
    assert.equal(method, "session/read", "a rejected model must not be selected");
    reads++; return snapshot;
  };
  try {
    await assert.rejects(() => state.ensureSessionModel(snapshot), /暂时没有可用的模型/);
    assert.equal(reads, 1);
    assert.equal(state.liveModelReady, false);
  } finally { client.dispose(); }
});

test("an empty attached catalog refreshes when its configured default is no longer available", async () => {
  const removed = { providerId: "removed", modelId: "old" };
  const current = { providerId: "prov", modelId: "replacement" };
  const { client, state } = fixture(removed, async model => model.providerId === "removed" ? false : null);
  state.lastRevision = 5;
  let reads = 0;
  state.sendRequest = async method => {
    assert.equal(method, "session/read"); reads++;
    return { settings: { model: { available: [{ ref: current }] } } };
  };
  const selected: string[] = [];
  state.setModel = async (_provider, model) => { selected.push(model); };
  try {
    await state.ensureSessionModel({ session: { sessionId: "A" }, runtime: { stateRevision: 5 },
      settings: { model: { available: [] } } });
    assert.equal(reads, 1);
    assert.deepEqual(selected, [current.modelId]);
  } finally { client.dispose(); }
});

test("partial subscribe settings still read the model-dependent reasoning controls", async () => {
  const {client,state}=fixture();let reads=0;
  state.subscribeConversation=async()=>{};state.alignAndEmitModel=async()=>{};
  state.ensureSessionModel=async()=>{};
  state.sendRequest=async method=>{
    const settings={model:{current:{providerId:"prov",modelId:"m1"},available:[]},mode:{current:"build"}};
    if(method === "session/subscribe")return {snapshot:{settings}};
    if(method === "session/read"){reads++;return {settings:{...settings,thoughtLevel:{enabled:true,current:"high",available:[{value:"high"}]}}};}
    return {};
  };
  try {
    await state.afterSessionAttached();
    assert.equal(reads,1);assert.equal(state.lastControls.thoughtLevel,"high");
    assert.equal(client.hasFreshSessionModel(),true);
    await client.emitSessionControls();assert.equal(reads,1);
  } finally {client.dispose();}
});

for (const scenario of ["unchanged", "advanced", "revision", "legacy", "wrong-owner", "missing-sequence"] as const) {
  test(`resume snapshot reuse preserves current metadata (${scenario})`, async () => {
    const { client, state, events } = fixture();
    const model = { providerId: "prov", modelId: "m1" };
    const snapshot = (title: string, level: string) => ({
      session: { sessionId: "A", title, model }, runtime: { eventSeq: 7, stateRevision: 5 },
      settings: { model: { current: model }, mode: { current: "build" },
        thoughtLevel: { enabled: true, current: level, available: [{ value: level }] } },
      slashCommands: [{ name: level, description: title }],
    });
    const original = snapshot("Original", "low");
    const current = snapshot("Current", "high");
    state.subscribeConversation = async () => {};
    state.alignAndEmitModel = async () => {};
    state.ensureSessionModel = async () => {};
    let reads = 0;
    state.sendRequest = async (method, params) => {
      if (method === "session/list") return { sessions: [] };
      if (method === "session/resume") {
        if (scenario === "legacy") return {};
        if (scenario === "wrong-owner") return { ...original, session: { ...original.session, sessionId: "B" } };
        return original;
      }
      if (method === "session/subscribe") {
        const p = params as { includeSnapshot: boolean; afterSeq: number; deliveryKind: string };
        assert.equal(p.afterSeq, 0);
        assert.equal(p.deliveryKind, "desktop-continuous");
        assert.equal(p.includeSnapshot, scenario === "legacy" || scenario === "wrong-owner");
        if (scenario === "revision") state.lastRevision = 6;
        return p.includeSnapshot ? { snapshot: current }
          : scenario === "missing-sequence" ? {} : { eventSeq: scenario === "advanced" ? 8 : 7 };
      }
      if (method === "session/read") {
        reads++;
        assert.equal((params as { messageLimit: number }).messageLimit, 1);
        return current;
      }
      return {};
    };
    try {
      await client.resumeSession("A", { sessionId: "A", title: "Listed", updatedAt: 1 });
      const reused = scenario === "unchanged";
      assert.equal(reads, ["advanced", "revision", "missing-sequence"].includes(scenario) ? 1 : 0);
      assert.equal(state.lastControls.thoughtLevel, reused ? "low" : "high");
      const ready = events.find(event => event.type === "session_ready");
      assert.equal((ready?.data as { title: string }).title, reused ? "Original" : "Current");
      assert.equal(client.hasFreshSessionModel(), true);
    } finally { client.dispose(); }
  });
}

test("resume response profiling records only sizes and time on its original timing scope", async () => {
  const { StartupTiming } = await import("./startupTiming");
  const { client } = fixture();
  const state = client as unknown as {
    sendRequest: (method: string, params?: unknown, timeout?: number) => Promise<unknown>;
    write: (message: {id:number}) => void;
    handleLine: (line:string) => void;
  };
  const original = new StartupTiming("open");
  const next = new StartupTiming("switch");
  let id = 0;
  state.write = message => {id=message.id;};
  try {
    client.setTiming(original);
    const pending = state.sendRequest("session/resume", {sessionId:"private-session"}, 0);
    client.setTiming(next);
    const result = {session:{sessionId:"private-session",title:"private-title"},text:"秘密正文",apiKey:"secret-test-only"};
    const line = JSON.stringify({id,result});
    state.handleLine(line);
    assert.deepEqual(await pending,result);
    const measured=original.snapshot();
    assert.equal(measured.resumeReplyBytes,Buffer.byteLength(line,"utf8"));
    assert.equal(typeof measured.resumeReplyParseMs,"number");
    assert.equal(typeof measured.resumeReplyReceivedMs,"number");
    assert.equal(next.snapshot().resumeReplyBytes,undefined);
    assert.ok(!JSON.stringify(measured).includes("secret-test-only"));
    assert.ok(!JSON.stringify(measured).includes("private-session"));
    assert.ok(!JSON.stringify(measured).includes("秘密正文"));
  } finally {client.dispose();}
});

test("authentication callback timing stays with its original startup across an await", async () => {
  const { StartupTiming } = await import("./startupTiming");
  const original=new StartupTiming("open"),next=new StartupTiming("switch");
  const auth=deferred<{apiKey:string}>();
  const client=new ZCodeClient({binaryPath:"/unused",workspacePath:"/test",onEvent:()=>{},resolveProviderAuth:()=>auth.promise});
  const state=client as unknown as {write:(message:unknown)=>void;handleProviderRuntimeHeaders:(id:number,params:unknown)=>Promise<void>};
  const replies:unknown[]=[];state.write=message=>replies.push(message);
  try {
    client.setTiming(original);
    const request=state.handleProviderRuntimeHeaders(1,{providerId:"test-provider"});
    await tick();client.setTiming(next);auth.resolve({apiKey:"test-only-key"});await request;
    assert.equal(replies.length,1);
    assert.equal(original.snapshot().runtimeHeadersRequests,1);
    assert.equal(original.snapshot().runtimeHeadersCacheMisses,1);
    assert.equal(typeof original.snapshot().runtimeHeadersMs,"number");
    assert.equal(next.snapshot().runtimeHeadersMs,undefined);
    assert.ok(!JSON.stringify(original.snapshot()).includes("test-only-key"));
  } finally {client.dispose();}
});

test("send admission rechecks desktop availability for cached models on every submission path", async () => {
  let enabled = false;
  const checked: unknown[] = [];
  const client = new ZCodeClient({ binaryPath: "/unused", workspacePath: "/test", onEvent: () => {},
    isSessionModelAvailable: async model => { checked.push(model); return enabled; } });
  const state = client as unknown as Internals;
  state.sessionId = "A";
  state.sessionModel = { providerId: "vendor", modelId: "old" };
  state.liveModelReady = true;
  state.lastLogEpoch = "epoch";
  const requests: Array<{method:string;params:unknown}> = [];
  state.sendRequest = async (method, params) => { requests.push({method,params}); return {status:"accepted"}; };
  try {
    for (const action of [
      () => client.sendMessage("ordinary"),
      () => client.insertQueuedMessage("queue"),
      () => client.insertQueuedMessage("/goal task"),
      () => client.insertQueuedMessage("/goal resume"),
      () => client.insertQueuedMessage("immediate", {immediate:true}),
      () => client.insertQueuedMessage("image", {attachments:[{attachmentId:"image"} as never]}),
      () => client.sendQueuedNow("queued"),
      () => client.editUserQuery({entityId:"question"} as never, "edited", "preserve"),
    ]) await assert.rejects(action, /该模型已不可用/);
    assert.equal(requests.length, 0, "a rejected model reached the backend (including stop-before-edit)");
    assert.ok(checked.length >= 6);
    enabled = true;
    await client.insertQueuedMessage("allowed", {immediate:true});
    assert.equal(requests.length, 1);
    assert.equal((requests[0].params as {sessionId:string}).sessionId, "A");
    assert.equal((requests[0].params as {payload:{text:string}}).payload.text, "allowed");
  } finally { client.dispose(); }
});

test("an availability check finishing after a session change cannot submit into either chat", async () => {
  const response = deferred<boolean>();
  const client = new ZCodeClient({binaryPath:"/unused", workspacePath:"/test", onEvent:()=>{}, isSessionModelAvailable:()=>response.promise});
  const state = client as unknown as Internals;
  state.sessionId = "A"; state.sessionModel = {providerId:"vendor",modelId:"model"};
  let requests = 0; state.sendRequest = async () => { requests++; return {status:"accepted"}; };
  try {
    const operation = client.insertQueuedMessage("from A");
    const rejected = assert.rejects(operation, /会话已切换/);
    state.sessionId = "B"; state.sessionGeneration++;
    response.resolve(true); await rejected;
    assert.equal(requests, 0);
  } finally { client.dispose(); }
});


test("staged model credentials do not replace the confirmed model after a rejected switch", async () => {
  const {client, state, events} = fixture();
  const previous = {providerId:"sample", modelId:"confirmed"};
  state.sessionModel = previous;
  client.setSessionRuntime({providerId:"other-sample",providerName:"Sample",modelId:"rejected",kind:"openai-compatible",
    baseURL:"https://example.test/v1",apiKey:"TEST-ONLY",models:{},source:"custom-provider"});
  state.sendRequest = async () => ({status:"rejected",message:"MODEL_REJECTED"});
  await assert.rejects(client.setModel("other-sample","rejected"), /MODEL_REJECTED/);
  assert.deepEqual(state.sessionModel, previous);
  assert.deepEqual(client.confirmedModel(), previous);
  assert.ok(!events.some(event => event.type === "model_info"));
  client.dispose();
});

test("confirmed controls preserve the base permission and return independent reasoning options", () => {
  const {client, state} = fixture();
  Object.assign(state,{baseMode:"build",planEnabled:true});
  state.lastControls = {mode:"plan",thoughtEnabled:true,thoughtLevel:"low",thoughtLevels:[{value:"low",label:"Low"}]};
  const controls = client.confirmedControls();
  assert.equal(controls.mode,"plan");
  assert.equal(controls.baseMode,"build");
  assert.equal(controls.planEnabled,true);
  assert.equal(controls.thoughtLevel,"low");
  controls.thoughtLevels[0].label = "Changed";
  assert.equal(state.lastControls.thoughtLevels[0].label,"Low");
  client.dispose();
});


test("PAT-backed runtime always resolves request auth instead of freezing its startup token", async () => {
  const runtime: ResolvedRuntime = {
    providerId: "account:zai-individual-coding-plan", providerName: "Test", modelId: "m", models: {},
    kind: "anthropic", baseURL: "https://example.invalid", apiKey: "TEST-STARTUP-TOKEN", apiKeyId: "TEST-KEY-ID",
    source: "desktop-personal-oauth",
  };
  let reads = 0;
  const client = new ZCodeClient({ binaryPath: "/unused", workspacePath: "/test", runtime, onEvent: () => {},
    resolveProviderAuth: async () => ({ apiKey: `TEST-REQUEST-TOKEN-${++reads}`, apiKeyId: "TEST-KEY-ID", accountScope: "TEST-ACCOUNT-SCOPE" }),
  });
  const replies: Array<{ result: { requestAuth?: { apiKey: string; apiKeyId?: string } } }> = [];
  const state = client as unknown as { write: (reply: unknown) => void; handleProviderRuntimeHeaders: (id: number, params: unknown) => Promise<void> };
  state.write = reply => replies.push(reply as typeof replies[number]);
  try {
    await state.handleProviderRuntimeHeaders(1, { providerId: runtime.providerId });
    await state.handleProviderRuntimeHeaders(2, { providerId: runtime.providerId });
    assert.deepEqual(replies.map(reply => reply.result.requestAuth), [
      { apiKey: "TEST-REQUEST-TOKEN-1", apiKeyId: "TEST-KEY-ID", accountScope: "TEST-ACCOUNT-SCOPE" },
      { apiKey: "TEST-REQUEST-TOKEN-2", apiKeyId: "TEST-KEY-ID", accountScope: "TEST-ACCOUNT-SCOPE" },
    ]);
    await state.handleProviderRuntimeHeaders(3, { providerId: runtime.providerId, expectedAccountScope: "OTHER-ACCOUNT" });
    assert.equal(replies[2].result.requestAuth, undefined);
  } finally { client.dispose(); }
});


test("permission changes serialize so a queued plan keeps the acknowledged base permission", async () => {
  const { client, state } = fixture();
  const response = deferred<unknown>();
  const calls: string[] = [];
  state.sendRequest = async (_method, params) => {
    calls.push((params as { mode: string }).mode);
    if (calls.length === 1) return response.promise;
    return {};
  };
  try {
    const first = client.setMode("edit");
    const second = client.setMode("plan");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ["edit"]);
    response.resolve({});
    await Promise.all([first, second]);
    assert.deepEqual(calls, ["edit", "plan"]);
    assert.equal(client.confirmedControls().baseMode, "edit");
    assert.equal(client.currentMode(), "plan");
  } finally { client.dispose(); }
});

test("a rejected permission change does not block the next change", async () => {
  const { client, state } = fixture();
  let attempts = 0;
  state.sendRequest = async () => { if (++attempts === 1) throw new Error("rejected"); return {}; };
  try {
    await assert.rejects(client.setMode("yolo"), /rejected/);
    await client.setMode("edit");
    assert.equal(client.currentMode(), "edit");
  } finally { client.dispose(); }
});


test("the create response wins over a previous chat's late runtime-preferences identity", async () => {
  const { client, state } = fixture();
  state.sendRequest = async (method) => {
    if (method === "session/create") {
      state.sessionId = "PREVIOUS";
      return { session: { sessionId: "CREATED" } };
    }
    return {};
  };
  (client as unknown as { afterSessionAttached: () => Promise<void> }).afterSessionAttached = async () => {};
  try {
    await client.newSession();
    assert.equal(client.currentSessionId, "CREATED");
  } finally { client.dispose(); }
});
