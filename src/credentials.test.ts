import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { type V2Provider, usesProjectTokens, tryPlanOAuth, fetchPlanQuota, readStartPlanAccess, readConfiguredProviderApiKey, readCredentialsWithRetry, readStoredPlanApiKeyWithRetry, readV2ConfigWithRetry, resolveApiKey, pickOrgAndProject, planAuthErrorDetails } from "./credentials";
import { readDesktopJsonWithRetry } from "./desktopJson";
import { mergeDesktopApiProviders, syncCliConfig, resolveProviderRequestAuth, resolveRuntime, resolveRuntimeForSession } from "./desktop";
import { ZCodeClient } from "./zcodeClient";

const os = require("os") as typeof import("os");
const writableFs = require("fs") as typeof import("fs");
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-login-test-"));
  const original = os.homedir; os.homedir = () => root;
  const dir = path.join(root, ".zcode", "v2"); fs.mkdirSync(dir, { recursive: true });
  t.after(() => { os.homedir = original; fs.rmSync(root, { recursive: true, force: true }); });
  return dir;
}

test("quota adapters can reuse only the exact ZCode shortcut provider key and host", async t => {
  const dir = fixture(t), file = path.join(dir, "provider_config.json");
  fs.writeFileSync(file, JSON.stringify({ config: { providerConfigRules: { providerRules: [
    { providerId: "custom-provider", config: { access: { type: "api-key", apiKey: "TEST-ONLY-REUSED-KEY" }, api: { baseUrl: "http://api.example.test/v1" } } },
    { providerId: "another-provider", config: { access: { type: "api-key", apiKey: "MUST-NOT-BE-USED" }, api: { baseUrl: "https://other.example.test/v1" } } },
  ] } } }));

  assert.deepEqual(await readConfiguredProviderApiKey("custom-provider"), {
    apiKey: "TEST-ONLY-REUSED-KEY",
    baseURL: "http://api.example.test/v1",
  });
  assert.equal(await readConfiguredProviderApiKey("missing-provider"), null);

  const root = path.dirname(path.dirname(dir));
  fs.mkdirSync(path.join(root, ".zcode", "cli"), { recursive: true });
  fs.writeFileSync(path.join(root, ".zcode", "cli", "config.json"), JSON.stringify({ provider: {
    "cli-provider": { options: { apiKey: "TEST-ONLY-CLI-KEY", baseURL: "https://cli.example.test/v1" } },
  } }));
  assert.deepEqual(await readConfiguredProviderApiKey("cli-provider"), {
    apiKey: "TEST-ONLY-CLI-KEY",
    baseURL: "https://cli.example.test/v1",
  });

  const rootConfig = JSON.parse(fs.readFileSync(file, "utf8"));
  const ambiguousRule = {
    providerId: "cli-provider",
    config: { access: { type: "api-key", apiKey: "AMBIGUOUS-KEY" }, api: { baseUrl: "https://ambiguous.example.test" } },
  };
  rootConfig.config.providerConfigRules.providerRules.push(ambiguousRule, { ...ambiguousRule });
  fs.writeFileSync(file, JSON.stringify(rootConfig));
  assert.deepEqual(await readConfiguredProviderApiKey("cli-provider"), {
    apiKey: "TEST-ONLY-CLI-KEY",
    baseURL: "https://cli.example.test/v1",
  }, "ambiguous shortcut rules are ignored rather than selecting a key");
});

test("provider shortcut credentials can omit a base URL and still require the configured template", async t => {
  const dir = fixture(t), file = path.join(dir, "provider_config.json");
  fs.writeFileSync(file, JSON.stringify({ config: { providerConfigRules: { providerRules: [
    { providerId: "deepseek", templateId: "deepseek", config: { access: { type: "api-key", apiKey: "TEST-ONLY-DEEPSEEK-KEY" } } },
    { providerId: "moonshot-kimi", templateId: "moonshot-kimi", config: { access: { type: "api-key", apiKey: "TEST-ONLY-KIMI-KEY" } } },
  ] } } }));

  assert.deepEqual(await readConfiguredProviderApiKey("deepseek", "deepseek"), {
    apiKey: "TEST-ONLY-DEEPSEEK-KEY",
  });
  assert.equal(await readConfiguredProviderApiKey("deepseek", "another-template"), null);
  assert.deepEqual(await readConfiguredProviderApiKey("moonshot-kimi", "moonshot-kimi"), {
    apiKey: "TEST-ONLY-KIMI-KEY",
  });
  assert.equal(await readConfiguredProviderApiKey("moonshot-kimi", "another-template"), null);
});

test("partial desktop config recovers before startup chooses a provider", async t => {
  const dir = fixture(t), file = path.join(dir, "config.json");
  fs.writeFileSync(file, '{"provider":'); fs.writeFileSync(path.join(dir, "setting.json"), '{}');
  const timer = setTimeout(() => fs.writeFileSync(file, JSON.stringify({provider:{fake:{enabled:true,options:{apiKey:'TEST-ONLY',baseURL:'http://localhost'},models:{test:{}}}}})), 30);
  t.after(() => clearTimeout(timer));
  const result = await resolveRuntime();
  assert.equal(result.ok, true); assert.equal(result.runtime?.providerId, "fake");
});

test("desktop shortcut model list removes stale CLI models and contributes current models", async t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: {
    sampleVendor: {
      name: "sampleVendor",
      kind: "openai-compatible",
      options: { apiKey: "TEST-ONLY-STALE-KEY", baseURL: "https://example.test/v1" },
      models: { "glm-5.2": {} },
    },
  } }));
  fs.writeFileSync(path.join(dir, "setting.json"), "{}");
  fs.writeFileSync(path.join(dir, "provider_config.json"), JSON.stringify({
    schemaVersion: 1,
    config: {
      providerOrder: ["sampleVendor"],
      providerConfigRules: {
        providerRules: [{
          providerId: "sampleVendor",
          providerName: "sampleVendor",
          config: {
            access: { type: "api-key", apiKey: "TEST-ONLY-SHORTCUT-KEY" },
            modelOrder: ["kimi-k3", "qwen3.8-max", "deepseek-v4-pro", "deepseek-v4-flash"],
            personalModelIds: ["kimi-k3", "qwen3.8-max", "deepseek-v4-pro", "deepseek-v4-flash"],
          },
        }],
      },
    },
  }));

  const result = await resolveRuntime();
  assert.deepEqual(
    result.picker.filter(model => model.providerId === "sampleVendor").map(model => model.modelId),
    ["kimi-k3", "qwen3.8-max", "deepseek-v4-pro", "deepseek-v4-flash"]
  );
  assert.deepEqual(result.disabledModelKeys, ["sampleVendor\0glm-5.2"]);
  assert.deepEqual(result.managedProviderIds, ["sampleVendor"]);
  assert.equal(JSON.stringify(result.picker).includes("TEST-ONLY"), false);
});

test("deleted desktop provider cannot become the runtime from a stale config row", async t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: {
    "deleted-sample": {
      name: "Removed sample provider",
      kind: "openai-compatible",
      options: { apiKey: "TEST-ONLY-DELETED-KEY", baseURL: "http://localhost" },
      models: { "sample-model": {} },
    },
    "active-provider": {
      name: "Active provider",
      kind: "openai-compatible",
      options: { apiKey: "TEST-ONLY-ACTIVE-KEY", baseURL: "http://localhost" },
      models: { "active-model": {} },
    },
  } }));
  fs.writeFileSync(path.join(dir, "setting.json"), "{}");
  fs.writeFileSync(path.join(dir, "provider_config.json"), JSON.stringify({ config: {
    providerConfigRules: { providerRules: [{
      providerId: "active-provider",
      providerName: "Active provider",
      config: {
        access: { type: "api-key", apiKey: "TEST-ONLY-ACTIVE-KEY" },
        modelOrder: ["active-model"],
      },
    }] },
  } }));

  const result = await resolveRuntime({
    preferredProviderId: "deleted-sample",
    preferredModelId: "sample-model",
  });
  assert.equal(result.ok, true);
  assert.equal(result.runtime?.providerId, "active-provider");
  assert.deepEqual(result.picker.map(model => model.providerId), ["active-provider"]);
  assert.equal(JSON.stringify(result.picker).includes("TEST-ONLY"), false);
  assert.equal(await resolveRuntimeForSession({ providerId: "deleted-sample", modelId: "sample-model" }), false,
    "an old session must not reuse the deleted provider's stale key");
});

test("a disabled saved default model falls back to the provider's enabled model", async t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: {
    sampleVendor: {
      name: "sampleVendor",
      kind: "openai-compatible",
      options: { apiKey: "TEST-ONLY-SAMPLE-KEY", baseURL: "https://example.test/v1" },
      models: { "disabled-model": {}, "enabled-model": {} },
    },
  } }));
  fs.writeFileSync(path.join(dir, "setting.json"), "{}");
  fs.writeFileSync(path.join(dir, "provider_config.json"), JSON.stringify({ config: {
    providerConfigRules: { providerRules: [{
      providerId: "sampleVendor",
      providerName: "sampleVendor",
      config: {
        access: { type: "api-key", apiKey: "TEST-ONLY-SAMPLE-KEY" },
        modelOrder: ["disabled-model", "enabled-model"],
      },
    }] },
    modelConfigRules: {
      providerModelRules: [{ providerId: "sampleVendor", modelId: "disabled-model", config: { enabled: false } }],
      manualProviderModelRules: [],
    },
  } }));

  const result = await resolveRuntime({ preferredProviderId: "sampleVendor", preferredModelId: "disabled-model" });
  assert.equal(result.ok, true);
  assert.deepEqual([result.runtime?.providerId, result.runtime?.modelId], ["sampleVendor", "enabled-model"]);
  assert.deepEqual(result.picker.map(model => model.modelId), ["enabled-model"]);
  assert.equal(await resolveRuntimeForSession({ providerId: "sampleVendor", modelId: "disabled-model" }), false,
    "resuming a session on an explicitly disabled model must not revive the stale provider config");

  const providerConfig = JSON.parse(fs.readFileSync(path.join(dir, "provider_config.json"), "utf8"));
  providerConfig.config.modelConfigRules.providerModelRules[0].config.enabled = true;
  fs.writeFileSync(path.join(dir, "provider_config.json"), JSON.stringify(providerConfig));
  const reenabled = await resolveRuntime({ preferredProviderId: "sampleVendor", preferredModelId: "disabled-model" });
  assert.deepEqual([reenabled.runtime?.providerId, reenabled.runtime?.modelId], ["sampleVendor", "disabled-model"]);
  assert.deepEqual(reenabled.picker.map(model => model.modelId), ["disabled-model", "enabled-model"]);
});

test("disabling a desktop provider removes its cached model from normal runtime selection", async t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: {
    "disabled-provider": {
      name: "Disabled provider",
      kind: "openai-compatible",
      options: { apiKey: "TEST-ONLY-DISABLED-KEY", baseURL: "https://example.test/v1" },
      models: { "disabled-model": {} },
    },
    "active-provider": {
      name: "Active provider",
      kind: "openai-compatible",
      options: { apiKey: "TEST-ONLY-ACTIVE-KEY", baseURL: "https://example.test/v1" },
      models: { "active-model": {} },
    },
  } }));
  fs.writeFileSync(path.join(dir, "setting.json"), "{}");
  fs.writeFileSync(path.join(dir, "provider_config.json"), JSON.stringify({ config: {
    providerConfigRules: { providerRules: [{
      providerId: "disabled-provider",
      enabled: false,
      config: {
        access: { type: "api-key", apiKey: "TEST-ONLY-DISABLED-KEY" },
        modelOrder: ["disabled-model"],
      },
    }, {
      providerId: "active-provider",
      config: {
        access: { type: "api-key", apiKey: "TEST-ONLY-ACTIVE-KEY" },
        modelOrder: ["active-model"],
      },
    }] },
  } }));

  const result = await resolveRuntime();
  assert.equal(result.ok, true);
  assert.deepEqual([result.runtime?.providerId, result.runtime?.modelId], ["active-provider", "active-model"]);
  assert.equal(await resolveRuntimeForSession({ providerId: "disabled-provider", modelId: "disabled-model" }), false);
});

test("the built-in API-key path also avoids a disabled desktop model", async t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: {
    "builtin:bigmodel": {
      name: "BigModel API",
      kind: "openai-compatible",
      options: { apiKey: "TEST-ONLY-BIGMODEL-KEY", baseURL: "https://example.test/v1" },
      models: { "disabled-model": {}, "enabled-model": {} },
    },
  } }));
  fs.writeFileSync(path.join(dir, "setting.json"), JSON.stringify({
    providerFamilyDomain: "bigmodel",
    modelProviderFamilyModes: { bigmodel: "apiKey" },
  }));
  fs.writeFileSync(path.join(dir, "provider_config.json"), JSON.stringify({ config: {
    providerConfigRules: { providerRules: [{
      providerId: "builtin:bigmodel",
      config: {
        access: { type: "api-key", apiKey: "TEST-ONLY-BIGMODEL-KEY" },
        modelOrder: ["disabled-model", "enabled-model"],
      },
    }] },
    modelConfigRules: {
      providerModelRules: [{ providerId: "builtin:bigmodel", modelId: "disabled-model", config: { enabled: false } }],
      manualProviderModelRules: [],
    },
  } }));

  const result = await resolveRuntime();
  assert.equal(result.ok, true);
  assert.deepEqual([result.runtime?.providerId, result.runtime?.modelId], ["builtin:bigmodel", "enabled-model"]);
});

test("the current desktop shortcut inventory wins over a stale CLI provider-disabled flag", async t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: {
    "active-shortcut": {
      name: "Active shortcut",
      enabled: false,
      kind: "openai-compatible",
      options: { apiKey: "TEST-ONLY-SHORTCUT-KEY", baseURL: "https://example.test/v1" },
      models: { "active-model": {} },
    },
  } }));
  fs.writeFileSync(path.join(dir, "setting.json"), "{}");
  fs.writeFileSync(path.join(dir, "provider_config.json"), JSON.stringify({ config: {
    providerConfigRules: { providerRules: [{
      providerId: "active-shortcut",
      enabled: true,
      config: {
        access: { type: "api-key", apiKey: "TEST-ONLY-SHORTCUT-KEY" },
        modelOrder: ["active-model"],
      },
    }] },
  } }));

  const result = await resolveRuntime();
  assert.equal(result.ok, true);
  assert.deepEqual([result.runtime?.providerId, result.runtime?.modelId], ["active-shortcut", "active-model"]);
});

test("Windows-style sharing violations recover without replacing credentials", async t => {
  const dir = fixture(t), file = path.join(dir, "credentials.json");
  fs.writeFileSync(file, JSON.stringify({'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:test:api-key':'TEST-ONLY'}));
  const read = writableFs.readFileSync; let attempts = 0;
  writableFs.readFileSync = ((name: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (name === file && ++attempts <= 2) throw Object.assign(new Error('Sharing violation'), {code:'EBUSY'});
    return (read as (...args: unknown[]) => unknown)(name, ...args);
  }) as typeof fs.readFileSync;
  t.after(() => { writableFs.readFileSync = read; });
  assert.equal(await readStoredPlanApiKeyWithRetry('account:bigmodel-individual-coding-plan'), 'TEST-ONLY');
  assert.equal(attempts, 3);
  assert.equal(fs.readFileSync(file,'utf8').includes('TEST-ONLY'), true);
});

test("atomic credential replacement and UTF-8 BOM are supported", async t => {
  const dir = fixture(t), file = path.join(dir, "credentials.json");
  const timer = setTimeout(() => fs.writeFileSync(file, '\uFEFF{"oauth:bigmodel:access_token":"TEST-TOKEN"}'), 30);
  t.after(() => clearTimeout(timer));
  assert.equal((await readCredentialsWithRetry())['oauth:bigmodel:access_token'], 'TEST-TOKEN');
});

test("permanent invalid config stops retrying and still returns no desktop defaults", async t => {
  const dir = fixture(t); fs.writeFileSync(path.join(dir,'config.json'), 'null');
  assert.equal(await readV2ConfigWithRetry(), null);
});

test("non-transient file errors are not retried", async t => {
  const dir = fixture(t), file = path.join(dir,'config.json');
  const read = writableFs.readFileSync; let attempts = 0;
  writableFs.readFileSync = ((name: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (name === file) { attempts++; throw Object.assign(new Error('I/O failure'), {code:'EIO'}); }
    return (read as (...args: unknown[]) => unknown)(name, ...args);
  }) as typeof fs.readFileSync;
  t.after(() => { writableFs.readFileSync = read; });
  await assert.rejects(readDesktopJsonWithRetry(file), {code:'EIO'}); assert.equal(attempts, 1);
});

test("encrypted credentials keep the same secret and cannot be reused with a wrong secret", async t => {
  const dir = fixture(t), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm',crypto.createHash('sha256').update('TEST-SECRET').digest(),iv);
  const data = Buffer.concat([cipher.update('TEST-TOKEN'),cipher.final()]);
  const token = 'enc:v1:'+iv.toString('base64url')+'.'+cipher.getAuthTag().toString('base64url')+'.'+data.toString('base64url');
  fs.writeFileSync(path.join(dir,'credentials.json'),JSON.stringify({'oauth:bigmodel:access_token':token}));
  assert.equal((await readCredentialsWithRetry({ZCODE_CREDENTIAL_SECRET:'TEST-SECRET'}))['oauth:bigmodel:access_token'],'TEST-TOKEN');
  assert.deepEqual(await readCredentialsWithRetry({ZCODE_CREDENTIAL_SECRET:'WRONG-SECRET'}),{});
});

for (const transient of [true, false]) {
  test(`read-only login exchange ${transient ? "recovers a connection reset" : "does not retry authentication rejection"}`, async t => {
    const https = require("https") as typeof import("https");
    const { EventEmitter } = require("events") as typeof import("events");
    const get = https.get; let calls = 0;
    https.get = ((url: string, _options: unknown, callback: (response: unknown) => void) => {
      calls++; const request = new EventEmitter() as import("events").EventEmitter & {setTimeout: () => void; destroy: () => void};
      request.setTimeout = () => {}; request.destroy = () => {};
      process.nextTick(() => {
        if (transient && calls === 1) { request.emit("error", Object.assign(new Error("Reset"),{code:"ECONNRESET"})); return; }
        const response = new EventEmitter(); callback(response);
        const data = url.includes("/copy/") ? {secretKey:"TEST-SECRET"} : [{name:"zcode-team-api-key",apiKey:"TEST-KEY",keyType:2}];
        response.emit("data", JSON.stringify({code:transient ? 200 : 401,data})); response.emit("end");
      });
      return request;
    }) as unknown as typeof https.get;
    t.after(() => { https.get = get; });
    const request = resolveApiKey("bigmodel","TEST-TOKEN",{organizationId:"test-org",projectId:"test-project"});
    if (transient) { assert.equal(await request,"TEST-KEY.TEST-SECRET"); assert.equal(calls,3); }
    else { await assert.rejects(request,/list_keys: rejected/); assert.equal(calls,1); }
  });
}

function mockPlanQuotaApi(t: TestContext, issueToken?: () => unknown, listedKeys?: unknown[]) {
  const https = require("https") as typeof import("https");
  const { EventEmitter } = require("events") as typeof import("events");
  const originalGet = https.get;
  const originalRequest = https.request;
  const requests: Array<{ method: string; host: string; path: string; headers: Record<string, string>; body?: string }> = [];
  let holdRequest: ((method: string, requestPath: string, headers: Record<string, string>) => Promise<void>) | undefined;
  let overrideResponse: ((requestPath: string, payload: unknown) => { payload: unknown; status?: number }) | undefined;
  const respond = (method: string, host: string, requestPath: string, headers: Record<string, string>, body: string, callback: (response: unknown) => void) => {
    requests.push({ method, host, path: requestPath, headers, ...(body ? { body } : {}) });
    let payload: unknown;
    if (requestPath === "/api/biz/customer/getCustomerInfo") {
      payload = { code: 200, data: { organizations: [{ organizationId: "org-current", projects: [{ projectId: "project-current" }] }] } };
    } else if (requestPath.startsWith("/api/v1/zcode-plan/billing/balance")) {
      payload = { code: 0, data: { plans: [], balances: [] } };
    } else if (requestPath === "/api/biz/subscription/list") {
      payload = { code: 200, data: [{ productName: "Coding Plan", status: "VALID", inCurrentPeriod: true }] };
    } else if (requestPath.endsWith("/api_keys")) {
      const isTeam = headers["bigmodel-organization"] === "org-current";
      payload = { code: 200, data: [{ name: isTeam ? "zcode-team-api-key" : "zcode-api-key", keyType: isTeam ? 2 : 1, apiKey: isTeam ? "TEST-TEAM-KEY-ID" : "TEST-PERSONAL-KEY-ID" }] };
      if (listedKeys) payload = { code: 200, data: method === "GET" ? listedKeys : {
        ...JSON.parse(body), apiKey: "TEST-CREATED-KEY-ID",
      } };
    } else if (requestPath.endsWith("/access_tokens")) {
      payload = issueToken?.() ?? { code: 200, data: { accessToken: "TEST-PAT", tokenType: "Bearer", expiresIn: 600, expiresAt: Date.now() / 1000 + 600 } };
    } else if (requestPath.includes("/copy/")) {
      payload = { code: 200, data: { secretKey: "TEST-ONLY-SECRET" } };
    } else if (requestPath.startsWith("/api/monitor/usage/quota/limit")) {
      payload = { code: 200, data: { limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 25, remaining: 75000, nextResetTime: 1900000000 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 40, remaining: 60000, nextResetTime: 1901000000 },
      ] } };
    } else {
      throw new Error(`Unexpected simulated plan request: ${method} ${host}${requestPath}`);
    }
    const override = overrideResponse?.(requestPath, payload);
    const response = new EventEmitter();
    Object.assign(response, { statusCode: override?.status ?? 200, complete: true, destroy() {} });
    callback(response);
    response.emit("data", JSON.stringify(override?.payload ?? payload));
    response.emit("end");
  };
  https.get = ((input: string | URL, options: { headers?: Record<string, string> }, callback: (response: unknown) => void) => {
    const url = new URL(String(input));
    const request = new EventEmitter() as import("events").EventEmitter & { setTimeout: () => void; destroy: () => void };
    request.setTimeout = () => {};
    request.destroy = () => {};
    const headers = options?.headers ?? {};
    const requestPath = url.pathname + url.search;
    const gate = holdRequest?.("GET", requestPath, headers);
    const send = () => process.nextTick(() => respond("GET", url.hostname, requestPath, headers, "", callback));
    if (gate) void gate.then(send, send);
    else send();
    return request;
  }) as unknown as typeof https.get;
  const post = (options: import("https").RequestOptions, callback: (response: unknown) => void) => {
    const request = new EventEmitter() as import("events").EventEmitter & { setTimeout: () => void; destroy: () => void; write: (data: string) => void; end: () => void };
    let body = "";
    request.setTimeout = () => {};
    request.destroy = () => {};
    request.write = (data: string) => { body += data; };
    request.end = () => {
      const headers = options.headers as Record<string, string> ?? {};
      const requestPath = String(options.path ?? "/");
      const send = () => process.nextTick(() => respond(String(options.method ?? "GET"), String(options.hostname ?? options.host ?? ""), requestPath, headers, body, callback));
      void Promise.resolve(holdRequest?.(String(options.method ?? "GET"), requestPath, headers)).then(send, send);
    };
    return request;
  };
  https.request = post as unknown as typeof https.request;
  t.after(() => { https.get = originalGet; https.request = originalRequest; });
  return { requests, hold(next: typeof holdRequest) { holdRequest = next; },
    respond(next: typeof overrideResponse) { overrideResponse = next; } };
}

for (const appVersion of ["3.14.4", "3.16.2"]) {
for (const family of ["bigmodel", "zai"] as const) {
 for (const teamPlan of [false, true]) {
  for (const route of ["headers", "align"] as const) {
   for (const failed of [false, true]) {
    test(`${appVersion} ${family} ${teamPlan ? "team" : "personal"} 401 invalidates OAuth cache before ${route}, refresh fails=${failed}`, async t => {
      const dir = fixture(t);
      const kind = teamPlan ? "team-coding-plan" : "individual-coding-plan";
      const providerId = `account:${family}-${kind}`;
      const team = teamPlan ? { organizationId: "org-current", projectId: "project-current" } : undefined;
      fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ [`oauth:${family}:access_token`]: "TEST-OAUTH" }));
      fs.writeFileSync(path.join(dir, "setting.json"), JSON.stringify({ providerFamilyDomain: family,
        modelProviderFamilyModes: { [family]: "oauth" },
        providerFamilyConnectionSelections: { [family]: { kind, ...team } } }));
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: {
        [providerId]: { name: "Fake", kind: "openai-compatible", options: { apiKey: "TEST-CONFIG-KEY", baseURL: "http://127.0.0.1:9" }, models: { test: {} } },
      } }));
      fs.writeFileSync(path.join(dir, "provider_config.json"), JSON.stringify({ config: {
        providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      } }));
      const keys = [{ name: teamPlan ? "zcode-team-api-key" : "zcode-api-key", apiKey: "TEST-OLD-KEY-ID", keyType: teamPlan ? 2 : 1 }];
      let issued = 0;
      const { requests } = mockPlanQuotaApi(t, usesProjectTokens(appVersion) ? () => ({ code: 200, data: {
        accessToken: `TEST-PAT-${++issued}`, tokenType: "Bearer", expiresIn: 600, expiresAt: Date.now() / 1000 + 600,
      } }) : undefined, keys);
      const initial = await resolveRuntime({ preferredProviderId: providerId, preferredModelId: "test", appVersion });
      assert.ok(initial.ok && initial.runtime);
      const oldKey = initial.runtime.apiKey;
      assert.equal(requests.filter(r => r.path.endsWith("/api_keys")).length, 1);
      keys[0].apiKey = "TEST-NEW-KEY-ID";
      const https = require("https") as typeof import("https");
      const get = https.get;
      if (failed) https.get = (() => {
        const request = new (require("events").EventEmitter)(); request.destroy = () => {};
        process.nextTick(() => request.emit("error", new Error("TEST-OFFLINE")));
        return request;
      }) as typeof https.get;
      const client = new ZCodeClient({ binaryPath: "/unused", workspacePath: "/test", runtime: initial.runtime,
        resolveSessionRuntime: model => resolveRuntimeForSession(model, appVersion), onEvent: () => {} });
      const state = client as unknown as {
        loginStale: boolean; sessionRuntime: { apiKey: string } | null; sessionId: string | null; desktopAppVersion: string;
        pending: Map<number, unknown>; write: (reply: unknown) => void; handleLine: (line: string) => void;
        handleProviderRuntimeHeaders: (id: number, params: unknown) => Promise<void>;
        alignSessionRuntime: (model: { providerId: string; modelId: string }) => Promise<void>;
      };
      const replies: Array<{ result: { headersApplied: boolean; requestAuth?: { apiKey: string } } }> = [];
      state.write = reply => replies.push(reply as typeof replies[number]);
      state.sessionId = "A";
      state.desktopAppVersion = appVersion;
      state.pending.set(1, { resolve() {}, reject() {} });
      try {
        state.handleLine(JSON.stringify({ id: 1, error: { code: 401, message: "Unauthorized" } }));
        assert.equal(state.loginStale, true);
        if (route === "headers") {
          await state.handleProviderRuntimeHeaders(2, { providerId });
          assert.equal(replies[0].result.headersApplied, !failed);
          assert.notEqual(replies[0].result.requestAuth?.apiKey, oldKey);
        } else {
          await state.alignSessionRuntime({ providerId, modelId: "test" });
          assert.notEqual(state.sessionRuntime?.apiKey, oldKey);
          assert.equal(state.sessionRuntime === null, failed);
        }
        assert.equal(state.loginStale, failed);
        if (!failed) assert.equal(requests.filter(r => r.path.endsWith("/api_keys")).length, 2);
      } finally { https.get = get; client.dispose(); }
    });
   }
  }
 }
}
}

for (const teamPlan of [false, true]) {
test(`legacy ${teamPlan ? "team" : "personal"} login never falls back to a rejected key or installs a result after account change`, async t => {
  const dir = fixture(t), file = path.join(dir, "credentials.json");
  fs.writeFileSync(file, JSON.stringify({ "oauth:bigmodel:access_token": "TEST-OAUTH" }));
  void mockPlanQuotaApi(t);
  const https = require("https") as typeof import("https");
  const get = https.get;
  let mode = "normal";
  https.get = ((...args: unknown[]) => {
    if (String(args[0]).endsWith("/api_keys")) {
      if (mode === "fail") {
        const request = new (require("events").EventEmitter)();
        request.destroy = () => {};
        process.nextTick(() => request.emit("error", new Error("TEST-OFFLINE")));
        return request;
      }
      if (mode === "switch") fs.writeFileSync(file, JSON.stringify({ "oauth:bigmodel:access_token": "TEST-NEW-ACCOUNT" }));
    }
    return (get as unknown as (...values: unknown[]) => unknown)(...args);
  }) as typeof https.get;
  const team = teamPlan ? { organizationId: "org-current", projectId: "project-current" } : undefined;
  const resolve = (fingerprint?: string) => tryPlanOAuth("bigmodel", team, "3.14.4", fingerprint);
  try {
    const first = await resolve();
    assert.ok(first?.apiKey);
    mode = "fail";
    assert.equal(await resolve(crypto.createHash("sha256").update(first.apiKey).digest("hex")), null);
    assert.equal(await resolve(), null, "failed refresh must not revive the rejected cache");
    mode = "switch";
    assert.equal(await resolve(), null, "a pending result belongs to the account that started it");
    mode = "normal";
    assert.ok((await resolve())?.apiKey, "the new account can retry normally");
  } finally { https.get = get; }
});
}

for (const family of ["bigmodel", "zai"] as const) {
 for (const teamPlan of [false, true]) {
  test(`${family} legacy ${teamPlan ? "team" : "personal"} login shares startup exchanges and invalidates on expiry, rejection and account changes`, async t => {
    const dir = fixture(t), file = path.join(dir, "credentials.json");
    const credentials = { [`oauth:${family}:access_token`]: "TEST-OAUTH" };
    fs.writeFileSync(file, JSON.stringify(credentials));
    const planApi = mockPlanQuotaApi(t); const { requests } = planApi;
    const team = teamPlan ? { organizationId: "org-current", projectId: "project-current" } : undefined;
    const resolve = (rejected?: string) => tryPlanOAuth(family, team, "3.14.4", rejected);
    const lists = () => requests.filter(r => r.path.endsWith("/api_keys")).length;
    const [first, concurrent] = await Promise.all([resolve(), resolve()]);
    assert.ok(first?.apiKey);
    assert.equal(first.apiKey, concurrent?.apiKey);
    assert.equal(lists(), 1);
    await fetchPlanQuota({ family, kind: teamPlan ? "team-coding-plan" : "individual-coding-plan", team }, "3.14.4");
    assert.equal(lists(), 1, "quota must reuse the same startup login");
    const originalNow = Date.now;
    let elapsed = 0;
    Date.now = () => originalNow() + elapsed;
    t.after(() => { Date.now = originalNow; });
    elapsed = 31_000;
    await resolve();
    assert.equal(lists(), 2, "legacy keys are revalidated after the short startup window");
    await resolve(crypto.createHash("sha256").update(first.apiKey).digest("hex"));
    assert.equal(lists(), 3, "a rejected key must not be reused");
    fs.writeFileSync(file, JSON.stringify({ [`oauth:${family}:access_token`]: "TEST-NEW-LOGIN" }));
    await resolve();
    assert.equal(lists(), 4);
    await tryPlanOAuth(family, { organizationId: "org-current", projectId: "project-other" }, "3.14.4");
    assert.equal(lists(), 5, "another project must not reuse the first project's login");
    elapsed += 31_000;
    const started = new Set<string>();
    let releaseExchanges!: () => void;
    const overlapping = new Promise<void>(resolve => { releaseExchanges = resolve; });
    planApi.hold(async (_method, requestPath, headers) => {
      if (!requestPath.endsWith("/api_keys")) return;
      started.add(headers["bigmodel-project"] || "personal");
      if (started.size === 2) releaseExchanges();
      await overlapping;
    });
    const personal = tryPlanOAuth(family, undefined, "3.14.4");
    const teamAuthPromise = tryPlanOAuth(family, { organizationId: "org-current", projectId: "project-concurrent" }, "3.14.4");
    for (let i = 0; i < 40 && started.size < 2; i++) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([...started].sort(), ["personal", "project-concurrent"]);
    const [personalAuth, teamAuth] = await Promise.all([personal, teamAuthPromise]);
    assert.ok(personalAuth?.apiKey && teamAuth?.apiKey);
    assert.notEqual(personalAuth.apiKey, teamAuth.apiKey);
    planApi.hold(undefined);
    fs.writeFileSync(file, "{}");
    assert.equal(await resolve(), null, "signing out must not reuse cached credentials");
  });
 }
}

for (const family of ["bigmodel", "zai"] as const) {
  test(`${family} Start Plan never falls back to OAuth personal API key exchange`, async t => {
    const dir = fixture(t), file = path.join(dir, "credentials.json");
    const credentials = { [`oauth:${family}:access_token`]: "TEST-OAUTH" };
    fs.writeFileSync(file, JSON.stringify(credentials));
    const planApi = mockPlanQuotaApi(t); const { requests } = planApi;
    const providerId = `account:${family}-start-plan`;
    const resolve = () => resolveProviderRequestAuth(providerId, "3.16.2");
    assert.equal(await resolve(), null);
    assert.equal(requests.length, 0);
    fs.writeFileSync(file, JSON.stringify({ ...credentials,
      [`account-provider:coding-plan:${providerId}:account:test:api-key`]: "TEST-STORED-KEY" }));
    assert.equal((await resolve())?.apiKey, "TEST-STORED-KEY", "cached OAuth must not hide a new desktop key");
    assert.equal(requests.length, 0);
  });
}

for (const family of ["bigmodel", "zai"] as const) {
  for (const kind of ["individual-coding-plan", "team-coding-plan"] as const) {
    test(`${family} ${kind} quota uses the selected OAuth account and scope`, async t => {
      const dir = fixture(t);
      const storedLogin = family === "zai" ? "TEST-ZAI-DESKTOP-BUSINESS" : "TEST-BIGMODEL-OAUTH";
      fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ [`oauth:${family}:access_token`]: storedLogin }));
      const planApi = mockPlanQuotaApi(t); const { requests } = planApi;
      const team = kind === "team-coding-plan" ? { organizationId: "org-current", projectId: "project-current" } : undefined;
      const quota = await fetchPlanQuota({ family, kind, ...(team ? { team } : {}) });

      assert.deepEqual(quota.map(row => [row.label, row.remainingPercent, row.remainingCount]), [
        ["5 小时", 75, 75000], ["每周", 60, 60000],
      ]);
      const host = family === "zai" ? "api.z.ai" : "bigmodel.cn";
      const quotaRequest = requests.find(request => request.path.startsWith("/api/monitor/usage/quota/limit"));
      assert.ok(quotaRequest, "quota request missing");
      assert.equal(quotaRequest.host, host);
      assert.equal(quotaRequest.path, kind === "team-coding-plan" ? "/api/monitor/usage/quota/limit?type=2" : "/api/monitor/usage/quota/limit");
      assert.equal(quotaRequest.headers.Authorization, `${kind === "team-coding-plan" ? "TEST-TEAM-KEY-ID" : "TEST-PERSONAL-KEY-ID"}.TEST-ONLY-SECRET`);
      const customerRequest = requests.find(request => request.path === "/api/biz/customer/getCustomerInfo");
      const keyListRequest = requests.find(request => request.path.endsWith("/api_keys"));
      assert.ok(keyListRequest, "selected account and project key were not resolved");
      const businessToken = family === "zai" ? `Bearer ${storedLogin}` : storedLogin;
      assert.equal(keyListRequest.headers.Authorization, businessToken);
      if (kind === "team-coding-plan") {
        assert.equal(customerRequest, undefined, "team scope must use the desktop-selected project directly");
        assert.equal(quotaRequest.headers["bigmodel-organization"], "org-current");
        assert.equal(quotaRequest.headers["bigmodel-project"], "project-current");
        assert.equal(keyListRequest.headers["bigmodel-organization"], "org-current");
        assert.equal(keyListRequest.headers["bigmodel-project"], "project-current");
      } else {
        assert.ok(customerRequest, "personal scope must resolve its unambiguous desktop organization/project");
        assert.equal(customerRequest.headers.Authorization, businessToken);
        assert.equal(quotaRequest.headers["bigmodel-organization"], undefined);
      }
      assert.equal(requests.some(request => request.path === "/api/auth/z/login"), false,
        "Desktop credentials must never be exchanged as raw OAuth tokens");
    });
  }
}

for (const failure of ["no-entitlement", "expired", "pending", "other-account", "no-jwt", "http-error"] as const) {
  test(`Start Plan ${failure} does not reuse personal keys or silently select paid API`, async t => {
    const dir = fixture(t);
    fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({
      "oauth:active_provider": failure === "other-account" ? "zai" : "bigmodel",
      "oauth:bigmodel:access_token": "TEST-OAUTH", ...(failure === "no-jwt" ? {} : { zcodejwttoken: "TEST-START-JWT" }),
    }));
    fs.writeFileSync(path.join(dir, "setting.json"), JSON.stringify({ providerFamilyDomain: "bigmodel",
      providerFamilyConnectionSelections: { bigmodel: { kind: "start-plan" } },
    }));
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: {
      "builtin:bigmodel-start-plan": { kind: "anthropic", models: { "GLM-5.3-Flash": {} } },
      paid: { kind: "anthropic", options: { apiKey: "TEST-PAID-KEY" }, models: { paid: {} } },
    } }));
    const api = mockPlanQuotaApi(t);
    api.respond((requestPath, payload) => requestPath.includes("billing/balance") ? {
      status: failure === "http-error" ? 403 : 200,
      payload: { code: 0, data: { server_time: 2000000000,
        plans: failure === "no-entitlement" ? [] : [{ plan_id: "zcode-v3-start-plan", status: "active",
          ...(failure === "expired" ? { ends_at: 1900000000 } : {}),
          ...(failure === "pending" ? { entitlements: [{ effective_at: 2100000000 }] } : {}),
        }], balances: [],
      } },
    } : { payload });
    const resolved = await resolveRuntime({ appVersion: "3.17.2" });
    assert.equal(resolved.ok, false);
    assert.equal(resolved.accountPlanUnavailable, true);
    assert.equal(api.requests.some(request => request.path.includes("api_keys") || request.path.includes("subscription/list")), false);
    if (failure === "other-account" || failure === "no-jwt") assert.equal(api.requests.length, 0);
  });
}

for (const selection of [undefined, "individual-coding-plan", "team-coding-plan"] as const) {
  test(`${selection ?? "missing"} selection preserves available personal/team Coding Plan`, async t => {
    const dir = fixture(t);
    fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ "oauth:active_provider": "bigmodel",
      "oauth:bigmodel:access_token": "TEST-OAUTH", zcodejwttoken: "TEST-START-JWT" }));
    fs.writeFileSync(path.join(dir, "setting.json"), JSON.stringify({ providerFamilyDomain: "bigmodel",
      ...(selection ? { providerFamilyConnectionSelections: { bigmodel: { kind: selection,
        ...(selection === "team-coding-plan" ? { organizationId: "org-current", projectId: "project-current" } : {}),
      } } } : {}),
    }));
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: {
      "builtin:bigmodel-coding-plan": { kind: "anthropic", models: { "GLM-5.3": {} } },
    } }));
    const api = mockPlanQuotaApi(t);
    const resolved = await resolveRuntime();
    assert.equal(resolved.ok, true);
    assert.equal(resolved.runtime?.providerId, "builtin:bigmodel-coding-plan");
    assert.equal(resolved.runtime?.apiKey, selection === "team-coding-plan" ? "TEST-TEAM-KEY-ID.TEST-ONLY-SECRET" : "TEST-PERSONAL-KEY-ID.TEST-ONLY-SECRET");
    if (selection === "team-coding-plan") assert.equal(api.requests.some(request => request.path.includes("billing/balance")), false);
  });
}

for (const family of ["bigmodel", "zai"] as const) {
  for (const appVersion of ["3.14.4", "3.17.1"]) {
    test(`${family} ${appVersion} keeps personal Coding Plan when the entitlement service is inconclusive`, async t => {
      const dir = fixture(t);
      fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({
        "oauth:active_provider": family, [`oauth:${family}:access_token`]: "TEST-DESKTOP-TOKEN",
        zcodejwttoken: "TEST-START-JWT",
      }));
      fs.writeFileSync(path.join(dir, "setting.json"), JSON.stringify({ providerFamilyDomain: family,
        providerFamilyConnectionSelections: { [family]: { kind: "individual-coding-plan" } },
      }));
      const providerId = `builtin:${family}-coding-plan`;
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: {
        [providerId]: { kind: "anthropic", models: { "GLM-5.3": {} } },
      } }));
      const api = mockPlanQuotaApi(t);
      for (const response of [
        { status: 503, payload: {} },
        { status: 200, payload: { code: 500 } },
        { status: 200, payload: { code: 200, data: [{ productName: "Coding Plan", status: "VALID" }] } },
      ]) {
        api.respond((requestPath, payload) => requestPath.endsWith("/subscription/list") ? response : { payload });
        const resolved = await resolveRuntime({ appVersion });
        assert.equal(resolved.ok, true);
        assert.equal(resolved.runtime?.providerId, providerId);
        assert.ok(resolved.runtime?.apiKey && resolved.runtime.apiKey !== "TEST-START-JWT");
      }
      assert.ok(api.requests.some(request => request.path.endsWith("/subscription/list")));
      assert.equal(api.requests.some(request => request.path.includes("billing/balance")), false);
    });
  }
}

for (const family of ["bigmodel", "zai"] as const) {
  for (const appVersion of ["3.14.4", "3.17.1"]) {
    test(`${family} ${appVersion} keeps personal Coding Plan when both plans are available and no choice was saved`, async t => {
      const dir = fixture(t);
      fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({
        "oauth:active_provider": family, [`oauth:${family}:access_token`]: "TEST-DESKTOP-TOKEN",
        zcodejwttoken: "TEST-START-JWT",
      }));
      fs.writeFileSync(path.join(dir, "setting.json"), JSON.stringify({ providerFamilyDomain: family }));
      const providerId = `builtin:${family}-coding-plan`;
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: {
        [providerId]: { kind: "anthropic", models: { "GLM-5.3": {} } },
      } }));
      const api = mockPlanQuotaApi(t);
      api.respond((requestPath, payload) => ({ payload: requestPath.includes("billing/balance") ? {
        code: 0, data: {
          plans: [{ user_plan_id: "start", plan_id: "zcode-start-plan", status: "active" }],
          balances: [{ user_plan_id: "start", capabilities: ["model:GLM-5.3"] }],
        },
      } : payload }));
      const resolved = await resolveRuntime({ appVersion });
      assert.equal(resolved.runtime?.providerId, providerId);
      assert.equal(api.requests.some(request => request.path.includes("billing/balance")), false);
      api.respond((requestPath, payload) => requestPath.endsWith("getCustomerInfo")
        ? { status: 503, payload: {} } : { payload });
      // Use a different account token to exercise a fresh exchange.
      fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({
        "oauth:active_provider": family, [`oauth:${family}:access_token`]: "TEST-SECOND-DESKTOP-TOKEN",
        zcodejwttoken: "TEST-START-JWT",
      }));
      const failed = await resolveRuntime({ appVersion });
      assert.equal(failed.ok, false);
      assert.equal(api.requests.some(request => request.path.includes("billing/balance")), false);
    });
  }
}

test("Start model names use desktop canonical IDs, deduplicate case-insensitively and preserve unknown spelling", async t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ "oauth:active_provider": "bigmodel", zcodejwttoken: "TEST-START-JWT" }));
  const api = mockPlanQuotaApi(t);
  api.respond(() => ({ payload: { code: 0, data: {
    plans: [{ user_plan_id: "start", plan_id: "zcode-v3-start-plan", status: "active" }],
    balances: [
      { user_plan_id: "start", capabilities: ["model:glm-5.3-flash", "model:GLM-5.3-Flash", "model:gLm-4.7-fLaShX", "model:glm-Next-Preview"] },
      { user_plan_id: "start", show_name: "GLM-5.3-FLASH" },
      { user_plan_id: "start", capabilities: ["model:GLM-NEXT-PREVIEW", "model:CustomMODEL", "model:custommodel"] },
      { user_plan_id: "start", show_name: "UnKnown-Display-Name" },
    ],
  } } }));
  assert.deepEqual((await readStartPlanAccess("bigmodel"))?.models,
    ["GLM-5.3-Flash", "GLM-4.7-FlashX", "glm-Next-Preview", "CustomMODEL", "UnKnown-Display-Name"]);
});

test("missing selection with no entitlements fails even when personal key exchange succeeds", async t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ "oauth:bigmodel:access_token": "TEST-OAUTH" }));
  fs.writeFileSync(path.join(dir, "setting.json"), JSON.stringify({ providerFamilyDomain: "bigmodel" }));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: {
    "builtin:bigmodel-coding-plan": { kind: "anthropic", models: { "GLM-5.3": {} } },
    paid: { kind: "anthropic", options: { apiKey: "TEST-PAID-KEY" }, models: { paid: {} } },
  } }));
  const api = mockPlanQuotaApi(t);
  api.respond((requestPath, payload) => ({ payload: requestPath.includes("subscription/list") ? { code: 200, data: [] } : payload }));
  const resolved = await resolveRuntime();
  assert.equal(resolved.ok, false);
  assert.equal(resolved.accountPlanUnavailable, true);
});

for (const family of ["bigmodel", "zai"] as const) {
  for (const selection of [undefined, "start-plan", "individual-coding-plan"] as const) {
    test(`${family} Start-only account resolves ${selection ?? "missing"} selection to JWT and entitled models`, async t => {
      const dir = fixture(t);
      fs.writeFileSync(path.join(dir, "telemetry-state.json"), JSON.stringify({ deviceMid: "a383f8b6-2933-48c1-b7da-b3e7faf51a51" }));
      fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({
        "oauth:active_provider": family, [`oauth:${family}:access_token`]: "TEST-OAUTH", zcodejwttoken: "TEST-START-JWT",
      }));
      fs.writeFileSync(path.join(dir, "setting.json"), JSON.stringify({ providerFamilyDomain: family,
        ...(selection ? { providerFamilyConnectionSelections: { [family]: { kind: selection } } } : {}),
      }));
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: {
        [`builtin:${family}-coding-plan`]: { kind: "anthropic", models: { "GLM-5.3": {} } },
        [`builtin:${family}-start-plan`]: { kind: "anthropic", options: { baseURL: "https://wrong.example.test" }, models: { "GLM-5.3": {} } },
        paid: { kind: "anthropic", options: { apiKey: "TEST-PAID-KEY" }, models: { paid: {} } },
      } }));
      const api = mockPlanQuotaApi(t);
      api.respond((requestPath, payload) => ({ payload: requestPath.startsWith("/api/v1/zcode-plan/billing/balance") ? {
        code: "0", data: { server_time: 2000000000,
          plans: [{ user_plan_id: "start", plan_id: "zcode-v3-start-plan", status: "active" }],
          balances: [{ user_plan_id: "start", show_name: "套餐额度", capabilities: ["model:glm-5.3-flash"], total_units: 100, remaining_units: 80 }],
        },
      } : requestPath === "/api/biz/subscription/list" ? { code: 200, data: [] } : payload }));
      const resolved = await resolveRuntime({ appVersion: "3.17.2" });
      assert.equal(resolved.ok, true);
      assert.equal(resolved.runtime?.providerId, `builtin:${family}-start-plan`);
      assert.equal(resolved.runtime?.apiKey, "TEST-START-JWT");
      assert.equal(resolved.runtime?.baseURL, "https://zcode.z.ai/api/v1/zcode-plan/anthropic");
      assert.equal(resolved.runtime?.modelId, "GLM-5.3-Flash");
      assert.deepEqual(Object.keys(resolved.runtime?.models ?? {}), ["GLM-5.3-Flash"]);
      assert.ok(resolved.picker.some(model => model.providerId === `builtin:${family}-start-plan` && model.modelId === "GLM-5.3-Flash"));
      const rulesDir = path.join(dir, "runtime/provider/test"); fs.mkdirSync(rulesDir, { recursive: true });
      fs.writeFileSync(path.join(rulesDir, "zcode-builtin.json"), JSON.stringify({ config: { providerConfigRules: { providerRules:
        ["individual-coding-plan", "start-plan"].map(kind => ({ providerId: `account:${family}-${kind}`, config: {
          access: { type: "zhipu-account", mode: kind, accountType: family }, builtinModelIds: ["GLM-5.3"],
        } })),
      } } }));
      const client = new ZCodeClient({ binaryPath: "/unused", workspacePath: "/test", pendingLogin: Promise.resolve(resolved), onEvent: () => {} });
      const internal = client as unknown as { syncAccountProviders: () => Promise<void>; sendRequest: (method: string, payload: unknown) => Promise<void> };
      let sync: { states: Record<string, { entitled: boolean }>; providers: Record<string, { builtinModelIds: string[] }> } | undefined;
      internal.sendRequest = async (_method, payload) => { sync = payload as typeof sync; };
      await internal.syncAccountProviders(); client.dispose();
      assert.equal(sync?.states[`account:${family}-start-plan`].entitled, true);
      assert.equal(sync?.states[`account:${family}-individual-coding-plan`].entitled, false);
      assert.deepEqual(sync?.providers[`account:${family}-start-plan`].builtinModelIds, ["GLM-5.3-Flash"]);
      assert.equal((await resolveProviderRequestAuth(`account:${family}-start-plan`, "3.17.2"))?.apiKey, "TEST-START-JWT");
      const quota = await fetchPlanQuota({ family, kind: "start-plan" }, "3.17.2");
      assert.equal(quota[0]?.remainingPercent, 80);
      const balanceRequest = api.requests.find(request => request.path.includes("billing/balance"));
      assert.equal(balanceRequest?.headers.Authorization, "Bearer TEST-START-JWT");
      assert.equal(balanceRequest?.headers["X-Device-Mid"], "a383f8b6-2933-48c1-b7da-b3e7faf51a51");
      assert.equal(balanceRequest?.headers["X-ZCode-App-Version"], "3.17.2");
      assert.match(balanceRequest?.path ?? "", /app_version=3.17.2/);
      if (selection === "start-plan") assert.equal(api.requests.some(request => request.path.includes("/api_keys")), false,
        "An explicit Start Plan selection must not exchange personal/team keys");
      const savedPersonal = await resolveRuntime({ appVersion: "3.17.2",
        preferredProviderId: `builtin:${family}-coding-plan`, preferredModelId: "GLM-5.3" });
      assert.equal(savedPersonal.runtime?.providerId, `builtin:${family}-start-plan`, "stale new-session personal defaults must not hide Start Plan");
      assert.equal(await resolveRuntimeForSession({ providerId: `builtin:${family}-coding-plan`, modelId: "GLM-5.3" }, "3.17.2"), null,
        "resuming a personal Coding Plan session must not silently substitute Start Plan");
      const restored = await resolveRuntimeForSession({ providerId: `account:${family}-start-plan`, modelId: "GLM-5.3-Flash" }, "3.17.2");
      assert.ok(restored, "lowercase balance capability must allow restoring a saved canonical model");
      assert.equal(restored.modelId, "GLM-5.3-Flash");
      assert.equal(await resolveRuntimeForSession({ providerId: `account:${family}-start-plan`, modelId: "GLM-5.3" }, "3.17.2"), null,
        "an existing session must not silently substitute a model absent from Start entitlements");
    });
  }
  test(`${family} Start Plan uses the ZCode JWT balance buckets`, async t => {
    const dir = fixture(t);
    fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ "oauth:active_provider": family, zcodejwttoken: "TEST-ZCODE-JWT" }));
    const https = require("https") as typeof import("https");
    const { EventEmitter } = require("events") as typeof import("events");
    const originalGet = https.get;
    const requests: Array<{ host: string; path: string; authorization?: string }> = [];
    https.get = ((input: string | URL, options: { headers?: Record<string, string> }, callback: (response: unknown) => void) => {
      const url = new URL(String(input));
      requests.push({ host: url.hostname, path: url.pathname + url.search, authorization: options.headers?.Authorization });
      const response = new EventEmitter();
      const request = new EventEmitter() as import("events").EventEmitter & { setTimeout: () => void; destroy: () => void };
      request.setTimeout = () => {};
      request.destroy = () => {};
      process.nextTick(() => {
        callback(response);
        response.emit("data", JSON.stringify({
          code: 0,
          data: {
            server_time: 2000000000,
            plans: [
              { user_plan_id: "trial-active", plan_id: "zcode-start-plan-trial", name: "Start Plan", status: "active", starts_at: 1900000000, ends_at: 2100000000 },
              { user_plan_id: "other-active", plan_id: "coding-plan-pro", name: "Coding Plan Pro", status: "active" },
              { user_plan_id: "trial-expired", plan_id: "zcode-start-plan-old", name: "Start Plan", status: "active", starts_at: 1800000000, ends_at: 1999999999 },
            ],
            balances: [
              { user_plan_id: "trial-active", plan_id: "zcode-start-plan-trial", show_name: "GLM-5.3", total_units: "3000000", remaining_units: "2400000", available_units: "2200000", expires_at: 2000100000 },
              { user_plan_id: "trial-active", plan_id: "zcode-start-plan-trial", show_name: "GLM-5.3-Flash", total_units: 5000000, remaining_units: 2500000, available_units: 2400000, expires_at: 2000200000 },
              { user_plan_id: "other-active", plan_id: "coding-plan-pro", show_name: "Unrelated plan", total_units: 100, remaining_units: 99, expires_at: 2000200000 },
              { user_plan_id: "trial-expired", plan_id: "zcode-start-plan-old", show_name: "Expired trial", total_units: 100, remaining_units: 80, expires_at: 2000200000 },
              { user_plan_id: "orphan", plan_id: "missing-plan", show_name: "Unattributed", total_units: 100, remaining_units: 50, expires_at: 2000200000 },
            ],
          },
        }));
        response.emit("end");
      });
      return request;
    }) as unknown as typeof https.get;
    t.after(() => { https.get = originalGet; });

    const quota = await fetchPlanQuota({ family, kind: "start-plan" }, "3.14.4");
    assert.deepEqual(quota.map(row => [row.label, row.remainingPercent, row.remainingCount, row.nextResetTime]), [
      ["GLM-5.3", 80, 2400000, 2000100000000],
      ["GLM-5.3-Flash", 50, 2500000, 2000200000000],
    ]);
    assert.deepEqual(requests, [{
      host: "zcode.z.ai",
      path: "/api/v1/zcode-plan/billing/balance?app_version=3.14.4",
      authorization: "Bearer TEST-ZCODE-JWT",
    }]);
  });
}


test("Coding Plan authentication preserves legacy desktops and recognizes PAT releases", () => {
  for (const version of [null, "", "invalid", "3.12.3", "3.14.4", "3.15.0"]) assert.equal(usesProjectTokens(version), false);
  for (const version of ["3.15.1", "3.16.2", "4.0.0"]) {
    assert.equal(usesProjectTokens(version), true);
  }
});

for (const family of ["bigmodel", "zai"] as const) {
  for (const teamPlan of [false, true]) {
    test(`${family} ${teamPlan ? "team" : "personal"} PAT uses endpoint-specific headers, shares refresh, and never copies secrets`, async t => {
      const dir = fixture(t);
      const login = family === "zai" ? "TEST-DESKTOP-BUSINESS" : "TEST-OAUTH";
      const credentials = { [`oauth:${family}:access_token`]: login };
      fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify(credentials));
      let issued = 0;
      const { requests } = mockPlanQuotaApi(t, () => ({ code: "200", data: {
        accessToken: `TEST-PAT-${++issued}`, tokenType: "Bearer", expiresIn: 600, expiresAt: Date.now() / 1000 + 600,
      } }));
      const team = teamPlan ? { organizationId: "org-current", projectId: "project-current" } : undefined;
      const resolve = () => tryPlanOAuth(family, team, "3.16.2");
      const [first, shared] = await Promise.all([resolve(), resolve()]);
      assert.equal(first?.apiKey, "TEST-PAT-1");
      assert.deepEqual(shared, first);
      assert.equal(issued, 1);
      assert.equal((await resolve())?.apiKey, "TEST-PAT-1");
      assert.equal(requests.find(r => r.path.endsWith("getCustomerInfo"))?.headers.Authorization, login);
      assert.equal(requests.find(r => r.path.endsWith("/api_keys"))?.headers.Authorization, !team && family === "zai" ? `Bearer ${login}` : login);
      const issue = requests.find(r => r.path.endsWith("/access_tokens"));
      assert.equal(issue?.headers.Authorization, `Bearer ${login}`);
      assert.deepEqual(JSON.parse(issue?.body ?? "null"), { clientType: "zcode", clientVersion: "3.16.2" });
      assert.equal(requests.some(r => r.path.includes("/copy/")), false);
      assert.equal(requests.some(r => r.path === "/api/auth/z/login"), false);
      assert.equal(first?.apiKeyId, teamPlan ? "TEST-TEAM-KEY-ID" : "TEST-PERSONAL-KEY-ID");

      const originalNow = Date.now;
      Date.now = () => originalNow() + 500_000;
      t.after(() => { Date.now = originalNow; });
      assert.equal((await resolve())?.apiKey, "TEST-PAT-2", "refresh before expiry");
      const fingerprint = crypto.createHash("sha256").update("TEST-PAT-2").digest("hex");
      assert.equal((await tryPlanOAuth(family, team, "3.16.2", fingerprint))?.apiKey, "TEST-PAT-3");
      fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ ...credentials, [`oauth:${family}:access_token`]: "TEST-OTHER-LOGIN" }));
      assert.equal((await resolve())?.apiKey, "TEST-PAT-4", "a new login cannot reuse the old token");
    });
  }
}

for (const data of [
  { enable: false },
  { accessToken: "TEST-PAT", tokenType: "Bearer", expiresIn: 600 },
  { accessToken: "TEST-PAT", tokenType: "Bearer", expiresIn: 600, expiresAt: 1 },
]) {
  test(`disabled or malformed PAT does not fall back to stored keys: ${JSON.stringify(data)}`, async t => {
    const dir = fixture(t);
    fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({
      "oauth:bigmodel:access_token": "TEST-OAUTH",
      "account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:old:api-key": "TEST-OLD-KEY",
    }));
    const { requests } = mockPlanQuotaApi(t, () => ({ code: 200, data }));
    assert.equal(await tryPlanOAuth("bigmodel", undefined, "3.16.2"), null);
    assert.equal(requests.some(r => r.path.includes("/copy/")), false);
    assert.deepEqual(await fetchPlanQuota({ family: "bigmodel", kind: "individual-coding-plan" }, "3.16.2"), []);
    assert.equal(requests.some(r => r.path.includes("/quota/limit")), false);
  });
}


for (const version of ["3.14.4", "3.15.1", "3.16.2"]) {
  test(`runtime and request-time login select the correct authentication for desktop ${version}`, async t => {
    const dir = fixture(t);
    const providerId = "account:zai-individual-coding-plan";
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: { [providerId]: {
      kind: "anthropic", models: { "glm-test": {} }, options: { apiKey: "TEST-STALE-CONFIG-KEY" },
    } } }));
    fs.writeFileSync(path.join(dir, "setting.json"), JSON.stringify({
      providerFamilyDomain: "zai", modelProviderFamilyModes: { zai: "oauth" },
    }));
    fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({
      "oauth:zai:access_token": "TEST-OAUTH",
      [`account-provider:coding-plan:${providerId}:account:old:api-key`]: "TEST-LEGACY-ACCOUNT-KEY",
    }));
    const { requests } = mockPlanQuotaApi(t, () => ({ code: 200, data: {
      enable: true, accessToken: "TEST-PAT", tokenType: "Bearer", expiresIn: 600, expiresAt: Date.now() / 1000 + 600,
    } }));
    const result = await resolveRuntime({ preferredProviderId: providerId, preferredModelId: "glm-test", appVersion: version });
    assert.equal(result.ok, true);
    const expected = version === "3.14.4" ? "TEST-LEGACY-ACCOUNT-KEY" : "TEST-PAT";
    assert.equal(result.runtime?.apiKey, expected);
    assert.equal((await resolveProviderRequestAuth(providerId, version))?.apiKey, expected);
    const session = await resolveRuntimeForSession({ providerId, modelId: "glm-test" }, version);
    assert.ok(session);
    assert.equal(session.apiKey, expected);
    assert.equal(result.runtime?.apiKeyId, version === "3.14.4" ? undefined : "TEST-PERSONAL-KEY-ID");
    if (version === "3.14.4") assert.ok(requests.every(request => request.path === "/api/biz/subscription/list"),
      "stored keys still require entitlement validation, without repeating key exchange");
  });
}

test("PAT refresh failures do not reuse the last token and can recover on the next request", async t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ "oauth:bigmodel:access_token": "TEST-OAUTH" }));
  let fail = false;
  void mockPlanQuotaApi(t, () => fail ? { code: 403, data: {} } : { code: 0, data: {
    accessToken: "TEST-PAT", tokenType: "Bearer", expiresIn: 600, expiresAt: Date.now() / 1000 + 600,
  } });
  assert.equal((await tryPlanOAuth("bigmodel", undefined, "3.16.2"))?.apiKey, "TEST-PAT");
  const originalNow = Date.now;
  Date.now = () => originalNow() + 700_000;
  t.after(() => { Date.now = originalNow; });
  fail = true;
  assert.equal(await tryPlanOAuth("bigmodel", undefined, "3.16.2"), null);
  fail = false;
  assert.equal((await tryPlanOAuth("bigmodel", undefined, "3.16.2"))?.apiKey, "TEST-PAT");
});

test("PAT creation uses the dedicated Coding Plan key and usage scene", async t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ "oauth:bigmodel:access_token": "TEST-OAUTH" }));
  const { requests } = mockPlanQuotaApi(t, () => ({ code: 200, data: {
    accessToken: "TEST-PAT", tokenType: "Bearer", expiresIn: 600, expiresAt: Date.now() / 1000 + 600,
  } }), []);
  const result = await tryPlanOAuth("bigmodel", { organizationId: "org-current", projectId: "project-current" }, "3.16.2");
  assert.equal(result?.apiKeyId, "TEST-CREATED-KEY-ID");
  assert.deepEqual(JSON.parse(requests.find(r => r.method === "POST" && r.path.endsWith("/api_keys"))?.body ?? "null"), {
    name: "zcode-team-api-key", keyType: 2, usageScene: 1,
  });
});

test("a team outside customerInfo cannot obtain a project token", async t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ "oauth:bigmodel:access_token": "TEST-OAUTH" }));
  const planApi = mockPlanQuotaApi(t); const { requests } = planApi;
  assert.equal(await tryPlanOAuth("bigmodel", { organizationId: "org-other", projectId: "project-other" }, "3.16.2"), null);
  assert.equal(requests.length, 1);
});

for (const version of ["3.14.4", "3.16.2"]) {
  for (const team of [false, true]) {
    for (const prefixed of [false, true]) {
      test(`Desktop Z.ai business credentials ${version} ${team ? "team" : "personal"} ${prefixed ? "with" : "without"} Bearer skip re-exchange`, async t => {
        const dir = fixture(t);
        fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({
          "oauth:zai:access_token": `${prefixed ? "Bearer " : ""}TEST-DESKTOP-BUSINESS`,
        }));
        const api = mockPlanQuotaApi(t, () => ({ code: "200", data: {
          accessToken: "TEST-PROJECT-TOKEN", tokenType: "Bearer", expiresIn: 600, expiresAt: Date.now() / 1000 + 600,
        } }));
        api.respond((requestPath, payload) => ({ payload: {
          ...payload as object, code: "200",
          ...(requestPath.endsWith("getCustomerInfo") ? { data: { organizations: [
            { organizationId: "other-org", projects: [{ projectId: "other-project", projectType: 1 }] },
            { organizationId: "org-current", organizationName: "默认机构", projects: [
              { projectId: "team-project", projectType: "2", projectName: "默认项目" },
              { projectId: "other-personal", projectType: 1 },
              { projectId: "project-current", projectType: 1, projectName: "默认项目" },
            ] },
          ] } } : {}),
        } }));
        const selectedTeam = team ? { organizationId: "org-current", projectId: "team-project" } : undefined;
        const result = await tryPlanOAuth("zai", selectedTeam, version);
        assert.ok(result?.apiKey);
        const keyRequest = api.requests.find(request => request.path.endsWith("/api_keys"))!;
        assert.ok(keyRequest.path.includes(`/organization/org-current/projects/${team ? "team-project" : "project-current"}/`));
        assert.equal(keyRequest.headers.Authorization, version === "3.16.2" && team
          ? "TEST-DESKTOP-BUSINESS" : "Bearer TEST-DESKTOP-BUSINESS");
        assert.equal(api.requests.some(request => request.path.includes("/api/auth/z/login")), false);
        assert.equal(api.requests.some(request => request.headers.Authorization?.includes("Bearer Bearer")), false);
        assert.equal(api.requests.some(request => request.path.includes("/copy/")), version === "3.14.4");
      });
    }
  }
}

for (const version of ["3.14.4", "3.16.2"]) {
  for (const team of [false, true]) {
    test(`Plan ${version} ${team ? "team" : "personal"} never reuses a key with the wrong name/type`, async t => {
      const dir = fixture(t);
      fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ "oauth:zai:access_token": "TEST-BUSINESS" }));
      const api = mockPlanQuotaApi(t, () => ({ code: 200, data: {
        accessToken: "TEST-PAT", tokenType: "Bearer", expiresIn: 600, expiresAt: Date.now() / 1000 + 600,
      } }), [{ name: team ? "zcode-team-api-key" : "unrelated-key", apiKey: "TEST-WRONG-KEY", keyType: 1 }]);
      assert.ok(await tryPlanOAuth("zai", team ? { organizationId: "org-current", projectId: "project-current" } : undefined, version));
      const created = api.requests.find(request => request.method === "POST" && request.path.endsWith("/api_keys"))!;
      assert.ok(created);
      assert.deepEqual(JSON.parse(created.body!), { name: team ? "zcode-team-api-key" : "zcode-api-key",
        ...(team ? { keyType: 2 } : {}), ...(version === "3.16.2" ? { usageScene: 1 } : {}) });
      assert.equal(api.requests.some(request => request.path.includes("TEST-WRONG-KEY")), false);
    });
  }
}

test("personal project selection excludes team-only organizations and matches Desktop's defaults", () => {
  const organizations = [
    { organizationId: "team-only", organizationName: "默认机构", projects: [{ projectId: "team", projectType: " 2 " }] },
    { organizationId: "first", projects: [{ projectId: "first-project" }] },
    { organizationId: "personal", organizationName: "个人默认机构", projects: [
      { projectId: "another" }, { projectId: "default", projectName: "默认项目" },
    ] },
  ];
  assert.deepEqual(pickOrgAndProject({ organizations }), { organizationId: "personal", projectId: "default" });
  assert.deepEqual(pickOrgAndProject({ organizations: organizations.slice(0, 2) }), { organizationId: "first", projectId: "first-project" });
  assert.equal(pickOrgAndProject({ organizations: organizations.slice(0, 1) }), null);
});

for (const [failurePath, expectedStage] of [["getCustomerInfo", "customer_info"], ["/api_keys", "list_keys"], ["/copy/", "copy_secret"]]) {
  test(`Plan HTTP failure at ${expectedStage} retains status/stage without leaking server secrets`, async t => {
    fixture(t);
    const api = mockPlanQuotaApi(t);
    api.respond((requestPath, payload) => requestPath.includes(failurePath)
      ? { status: 403, payload: { code: 403, msg: "TEST-SERVER-SECRET", data: { secretKey: "TEST-SECRET" } } }
      : { payload });
    await assert.rejects(resolveApiKey("zai", "Bearer TEST-PRIVATE-BUSINESS"), error => {
      const details = planAuthErrorDetails(error);
      assert.equal(details.stage, expectedStage);
      assert.equal(details.status, 403);
      assert.equal(details.category, "http");
      assert.equal(details.code, "HTTP_STATUS");
      assert.doesNotMatch(JSON.stringify(details) + String(error), /TEST-/);
      return true;
    });
  });
}

for (const rejected of [true, false]) {
  test(`Plan copy diagnostics distinguish ${rejected ? "business rejection" : "missing secret"}`, async t => {
    fixture(t);
    const api = mockPlanQuotaApi(t);
    api.respond((requestPath, payload) => requestPath.includes("/copy/")
      ? { payload: { code: rejected ? "401" : "200", msg: "TEST-RAW-SECRET", data: {} } } : { payload });
    await assert.rejects(resolveApiKey("zai", "Bearer TEST-BUSINESS"), error => {
      const details = planAuthErrorDetails(error);
      assert.equal(details.stage, "copy_secret");
      assert.equal(details.status, 200);
      assert.equal(details.resultCode, rejected ? "401" : "200");
      assert.equal(details.category, rejected ? "business" : "invalid_response");
      assert.doesNotMatch(JSON.stringify(details) + String(error), /TEST-/);
      return true;
    });
  });
}

test("Plan diagnostics never project arbitrary error messages, names or codes", () => {
  const error = Object.assign(new Error("TEST-PRIVATE-TOKEN"), { name: "TEST-PRIVATE-KEY", code: "TEST-PRIVATE-SECRET" });
  assert.doesNotMatch(JSON.stringify(planAuthErrorDetails(error)), /TEST-/);
});


for (const stale of [false, true]) {
  for (const [type, kind] of [["openai-chat-completions", "openai-compatible"], ["anthropic-messages", "anthropic"], ["openai-responses", "openai"]]) {
    test(`chat uses current ${type} credentials and endpoint with ${stale ? "stale" : "no"} legacy config`, async t => {
      const dir = fixture(t);
      const providerId = "new-provider";
      const legacy: Record<string, V2Provider> = stale ? { [providerId]: {
        kind: "openai-compatible", options: { apiKey: "TEST-OLD-KEY", baseURL: "https://old.example.test/v1" },
        models: { "old-model": {} },
      } } : {};
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: legacy }));
      fs.writeFileSync(path.join(dir, "setting.json"), "{}");
      fs.writeFileSync(path.join(dir, "provider_config.json"), JSON.stringify({ config: { providerConfigRules: { providerRules: [{
        providerId, providerName: "Current provider", config: {
          access: { type: "api-key", apiKey: "TEST-NEW-KEY" },
          api: { type, baseUrl: "https://new.example.test/v1" }, modelOrder: ["current-model"],
        },
      }] } } }));
      const result = await resolveRuntime({ preferredProviderId: providerId, preferredModelId: "current-model" });
      assert.equal(result.ok, true);
      assert.equal(result.runtime?.apiKey, "TEST-NEW-KEY");
      assert.equal(result.runtime?.baseURL, "https://new.example.test/v1");
      assert.equal(result.runtime?.kind, kind);
      assert.equal(JSON.stringify(result.picker).includes("TEST-NEW-KEY"), false);
      const session = await resolveRuntimeForSession({ providerId, modelId: "current-model" });
      assert.ok(session);
      assert.equal(session.apiKey, "TEST-NEW-KEY");
      const automatic = await resolveRuntime();
      assert.equal(automatic.runtime?.apiKey, "TEST-NEW-KEY");
      const file = syncCliConfig(result.runtime!, { provider: legacy });
      const synced = JSON.parse(fs.readFileSync(file, "utf8")).provider[providerId];
      assert.deepEqual([synced.options.apiKey, synced.options.baseURL, synced.kind],
        ["TEST-NEW-KEY", "https://new.example.test/v1", kind]);
      if (stale) assert.equal(await resolveRuntimeForSession({ providerId, modelId: "old-model" }), false);
    });
  }
}

test("desktop API templates supply protocol and endpoint without mixing stale settings", () => {
  const personal = { config: { providerConfigRules: { providerRules: [{
    providerId: "shortcut", templateId: "example", config: {
      access: { apiKey: "TEST-CURRENT-KEY" }, personalModelIds: ["custom-model"],
    },
  }] } } };
  const builtin = { config: { providerConfigRules: { templateRules: [{
    templateId: "example", config: {
      access: { type: "api-key" }, api: { type: "anthropic-messages", baseUrl: "https://template.example.test" },
      builtinModelIds: ["template-model"],
    },
  }] } } };
  const providers = mergeDesktopApiProviders({ shortcut: {
    kind: "openai-compatible", options: { apiKey: "TEST-OLD-KEY", baseURL: "https://old.example.test" },
  } }, personal, builtin);
  assert.equal(providers.shortcut.kind, "anthropic");
  assert.equal(providers.shortcut.options?.apiKey, "TEST-CURRENT-KEY");
  assert.equal(providers.shortcut.options?.baseURL, "https://template.example.test");
  assert.deepEqual(Object.keys(providers.shortcut.models ?? {}), ["custom-model", "template-model"]);
});

test("clearing a current desktop key cannot resurrect the legacy key", async t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: { sample: {
    options: { apiKey: "TEST-OLD-KEY", baseURL: "https://old.example.test" }, models: { model: {} },
  } } }));
  fs.writeFileSync(path.join(dir, "setting.json"), "{}");
  fs.writeFileSync(path.join(dir, "provider_config.json"), JSON.stringify({ config: { providerConfigRules: { providerRules: [{
    providerId: "sample", config: { access: { type: "api-key", apiKey: "" }, modelOrder: ["model"] },
  }] } } }));
  assert.equal((await resolveRuntime({ preferredProviderId: "sample", preferredModelId: "model", strictPreferredProvider: true })).ok, false);
  assert.equal(await resolveRuntimeForSession({ providerId: "sample", modelId: "model" }), false);
});


test("CLI synchronization updates or removes credentials for providers other than the selected one", t => {
  const dir = fixture(t);
  const legacy = { sample: { options: { apiKey: "TEST-OLD-KEY", baseURL: "https://old.example.test" }, models: { model: {} } } };
  const runtime = {
    providerId: "active", providerName: "Active", modelId: "model", models: { model: {} },
    kind: "openai-compatible", baseURL: "https://active.example.test", apiKey: "TEST-ACTIVE-KEY", source: "custom-provider" as const,
  };
  for (const key of ["TEST-NEW-KEY", ""]) {
    fs.writeFileSync(path.join(dir, "provider_config.json"), JSON.stringify({ config: { providerConfigRules: { providerRules: [
      { providerId: "sample", config: {
        access: { type: "api-key", apiKey: key }, api: { type: "anthropic-messages", baseUrl: "https://new.example.test" }, modelOrder: ["model"],
      } },
      { providerId: "active", config: { access: { type: "api-key", apiKey: "TEST-ACTIVE-KEY" }, modelOrder: ["model"] } },
    ] } } }));
    const file = syncCliConfig(runtime, { provider: legacy });
    const provider = JSON.parse(fs.readFileSync(file, "utf8")).provider.sample;
    if (key) assert.deepEqual([provider.options.apiKey, provider.options.baseURL, provider.kind],
      ["TEST-NEW-KEY", "https://new.example.test", "anthropic"]);
    else assert.equal(provider, undefined);
  }
});
