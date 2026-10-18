import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import {
  DEEPSEEK_QUOTA_ADAPTER,
  KIMI_QUOTA_ADAPTER,
  buildQuotaAdapterRegistry,
  fetchQuotaAdapter,
  mapQuotaResponse,
  quotaEndpointsMatchProvider,
  quotaSecretStorageKey,
  validateQuotaAdapter,
} from "./quotaAdapters";

const httpsModule = require("https") as { request: typeof import("https").request };

const adapter = {
  id: "test-provider",
  providerId: "custom/provider",
  displayName: "Test budget",
  endpoint: "https://quota.example.test/v1/usage",
  auth: "header",
  authHeaderName: "x-api-key",
  method: "GET",
  itemsPath: "/data/limits",
  percentScale: "0-1",
  fields: [{
    labelPath: "/name",
    remainingPercentPath: "/remaining_ratio",
    remainingCountPath: "/remaining",
    nextResetTimePath: "/reset_at",
    resetTimeFormat: "auto",
  }],
};

test("quota adapters map JSON Pointer rows, fraction percentages and reset timestamps", () => {
  const quota = mapQuotaResponse({ data: { limits: [
    { name: "Fast", remaining_ratio: "0.75", remaining: "1200", reset_at: 1_800_000_000 },
    { name: "Weekly", remaining_ratio: 0.25, remaining: 300, reset_at: "2030-01-01T00:00:00Z" },
  ] } }, adapter);
  assert.deepEqual(quota, [
    { label: "Fast", remainingPercent: 75, usedPercent: 25, remainingCount: 1200, nextResetTime: 1_800_000_000_000 },
    { label: "Weekly", remainingPercent: 25, usedPercent: 75, remainingCount: 300, nextResetTime: Date.parse("2030-01-01T00:00:00Z") },
  ]);
});

test("quota adapters map monetary balances and keep the built-in DeepSeek mapping as data", () => {
  const config = {
    ...adapter,
    itemsPath: "/balances",
    fields: [{
      labelPath: "/currency", currencyPath: "/currency", remainingAmountPath: "/remaining",
      grantedAmountPath: "/granted", toppedUpAmountPath: "/recharged",
    }],
  };
  assert.deepEqual(mapQuotaResponse({ balances: [{ currency: "EUR", remaining: "3.2", granted: 1, recharged: 2 }] }, config), [
    { label: "EUR", remainingAmount: 3.2, currency: "EUR", grantedAmount: 1, toppedUpAmount: 2 },
  ]);
  assert.deepEqual(mapQuotaResponse({ balance_infos: [{ currency: "CNY", total_balance: "12.5", granted_balance: "2", topped_up_balance: "10.5" }] }, DEEPSEEK_QUOTA_ADAPTER), [
    { label: "CNY", remainingAmount: 12.5, currency: "CNY", grantedAmount: 2, toppedUpAmount: 10.5 },
  ]);
  assert.equal(DEEPSEEK_QUOTA_ADAPTER.apiKeySource, "zcode");
  assert.equal(DEEPSEEK_QUOTA_ADAPTER.providerTemplateId, "deepseek");
  assert.equal(DEEPSEEK_QUOTA_ADAPTER.providerBaseURL, "https://api.deepseek.com");
  assert.deepEqual(mapQuotaResponse({ data: {
    available_balance: 49.58894,
    voucher_balance: 46.58893,
    cash_balance: 3.00001,
  } }, KIMI_QUOTA_ADAPTER), [
    { label: "Kimi API", remainingAmount: 49.58894, currency: "CNY", grantedAmount: 46.58893 },
  ]);
  assert.equal(KIMI_QUOTA_ADAPTER.apiKeySource, "zcode");
  assert.equal(KIMI_QUOTA_ADAPTER.providerId, "moonshot-kimi");
  assert.equal(KIMI_QUOTA_ADAPTER.providerTemplateId, "moonshot-kimi");
  assert.equal(KIMI_QUOTA_ADAPTER.providerBaseURL, "https://api.moonshot.cn");
});

test("quota adapters map standalone money and numeric metrics from combined responses", () => {
  const config = {
    id: "provider-spend",
    providerId: "custom/provider-spend",
    displayName: "Provider spend",
    auth: "bearer",
    requests: [{ id: "usage", endpoint: "https://quota.example.test/v1/daily-usage" }],
    fields: [{
      label: "Today",
      metrics: [
        { label: "Spend", period: "Today", valuePath: "/usage/cost", format: "currency", currency: "CNY" },
        { label: "Requests", periodPath: "/usage/day", valuePath: "/usage/requests", format: "number", unit: "requests" },
      ],
    }],
  };
  assert.deepEqual(mapQuotaResponse({ usage: { cost: "12.35", requests: 8, day: "2026-10-14" } }, config), [{
    label: "Today",
    metrics: [
      { label: "Spend", value: 12.35, format: "currency", currency: "CNY", period: "Today" },
      { label: "Requests", value: 8, format: "number", unit: "requests", period: "2026-10-14" },
    ],
  }]);
  assert.throws(() => validateQuotaAdapter({
    ...config,
    fields: [{ label: "Today", metrics: [{ label: "Spend", valuePath: "/usage/cost", format: "currency" }] }],
  }), /invalid-config/);
  assert.throws(() => validateQuotaAdapter({
    ...config,
    fields: [{ label: "Today", metrics: [{ label: "Requests", valuePath: "/usage/requests", format: "number", currency: "CNY" }] }],
  }), /invalid-config/);
  assert.equal(validateQuotaAdapter(config).schemaVersion, 1, "settings without a version resolve to protocol v1");
  assert.throws(() => validateQuotaAdapter({ ...config, schemaVersion: 2 }), /invalid-config/);
  const forwardCompatible = validateQuotaAdapter({
    ...config,
    futureAdapterOption: true,
    fields: [{ label: "Today", metrics: [{ label: "Spend", valuePath: "/usage/cost", futureMetricOption: true }] }],
  });
  assert.equal(forwardCompatible.providerId, config.providerId, "unknown optional keys do not disable a valid adapter");
});

test("quota adapter metrics combine selected response fields with bounded arithmetic", () => {
  const config = {
    id: "provider-composed-metrics",
    providerId: "custom/provider-composed-metrics",
    displayName: "Usage metrics",
    auth: "bearer",
    requests: [{ id: "usage", endpoint: "https://quota.example.test/v1/usage" }],
    fields: [{
      label: "Today",
      metrics: [
        {
          label: "Combined spend",
          period: "Today",
          format: "currency",
          currency: "CNY",
          calculation: { operation: "sum", paths: ["/usage/input_cost", "/usage/output_cost"] },
        },
        {
          label: "Net credits",
          format: "number",
          unit: "credits",
          calculation: { operation: "subtract", paths: ["/usage/granted", "/usage/used"] },
        },
        {
          label: "Input tokens",
          format: "number",
          unit: "tokens",
          calculation: { operation: "divide", paths: ["/usage/input_millitokens", "/usage/divisor"], divisor: 1000 },
        },
      ],
    }],
  };
  assert.deepEqual(mapQuotaResponse({ usage: {
    input_cost: "1.25", output_cost: 2.5,
    granted: 12, used: 3,
    input_millitokens: 7500, divisor: 1,
  } }, config), [{
    label: "Today",
    metrics: [
      { label: "Combined spend", value: 3.75, format: "currency", currency: "CNY", period: "Today" },
      { label: "Net credits", value: 9, format: "number", unit: "credits" },
      { label: "Input tokens", value: 7.5, format: "number", unit: "tokens" },
    ],
  }]);
  assert.throws(() => validateQuotaAdapter({
    ...config,
    fields: [{ label: "Today", metrics: [{ label: "Bad", valuePath: "/usage/input_cost", calculation: { operation: "sum", paths: ["/usage/input_cost", "/usage/output_cost"] } }] }],
  }), /invalid-config/, "a metric has exactly one source: a direct field or a calculation");
  assert.throws(() => validateQuotaAdapter({
    ...config,
    fields: [{ label: "Today", metrics: [{ label: "Bad", calculation: { operation: "divide", paths: ["/usage/input_cost", "/usage/output_cost", "/usage/other"] } }] }],
  }), /invalid-config/, "division remains binary");
  assert.deepEqual(mapQuotaResponse({ usage: { input_cost: 12, output_cost: 3, granted: 1, used: 2, input_millitokens: 10, divisor: 0 } }, config)[0].metrics?.[2], undefined,
    "division by zero produces no metric rather than Infinity");
});

test("quota adapters derive non-monetary remaining counts and normalize direct values", () => {
  const calculated = {
    id: "provider-token-quota",
    providerId: "custom/provider-token-quota",
    displayName: "Token quota",
    endpoint: "https://quota.example.test/v1/usage",
    auth: "none",
    fields: [{
      label: "Monthly tokens",
      quotaCalculation: {
        limitPath: "/limit_milli",
        usedPath: "/used_milli",
        limitDivisor: 1000,
        usedDivisor: 1000,
      },
    }],
  };
  assert.deepEqual(mapQuotaResponse({ limit_milli: 128000, used_milli: 96000 }, calculated), [{
    label: "Monthly tokens", remainingPercent: 25, usedPercent: 75, remainingCount: 32,
  }]);

  const normalized = {
    id: "provider-minor-units",
    providerId: "custom/provider-minor-units",
    displayName: "Minor units",
    endpoint: "https://quota.example.test/v1/balance",
    auth: "none",
    fields: [{
      label: "Account",
      remainingAmountPath: "/balance_cents",
      currency: "CNY",
      amountDivisor: 100,
      remainingCountPath: "/tokens_milli",
      countDivisor: 1000,
      metrics: [{ label: "Spend", valuePath: "/spend_cents", valueDivisor: 100, format: "currency", currency: "CNY" }],
    }],
  };
  assert.deepEqual(mapQuotaResponse({ balance_cents: 1234, tokens_milli: 5000, spend_cents: 123 }, normalized), [{
    label: "Account",
    remainingAmount: 12.34,
    currency: "CNY",
    remainingCount: 5,
    metrics: [{ label: "Spend", value: 1.23, format: "currency", currency: "CNY" }],
  }]);
});

test("built-in presets and user adapters share one registry and reject provider collisions", () => {
  const userAdapter = { ...adapter, id: "user-adapter", providerId: "user-provider" };
  const registry = buildQuotaAdapterRegistry([
    userAdapter,
    { ...adapter, id: "duplicate-provider-entry-a", providerId: "duplicate-provider" },
    { ...adapter, id: "duplicate-provider-entry-b", providerId: "duplicate-provider" },
    { ...userAdapter, id: "builtin-provider-collision", providerId: "deepseek" },
    { ...userAdapter, id: "builtin-kimi-collision", providerId: "moonshot-kimi" },
    { ...userAdapter, id: "unsafe-adapter", endpoint: "http://example.test/quota" },
  ]);
  assert.deepEqual(registry.map(item => item.providerId), ["deepseek", "moonshot-kimi", "user-provider"]);
  assert.equal(registry[0].id, DEEPSEEK_QUOTA_ADAPTER.id);
  assert.equal(registry[1].id, KIMI_QUOTA_ADAPTER.id);
  assert.equal(registry[2].id, "user-adapter");
});

test("the built-in DeepSeek preset uses the same generic request and mapping function", async t => {
  const originalRequest = httpsModule.request;
  let requestUrl = "";
  let authorization = "";
  httpsModule.request = ((input: string | URL, options: { headers?: Record<string, string> }, callback: (response: unknown) => void) => {
    requestUrl = String(input);
    authorization = options.headers?.Authorization ?? "";
    const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    request.destroy = () => {};
    request.end = () => process.nextTick(() => {
      const response = new EventEmitter();
      Object.assign(response, { statusCode: 200, resume: () => {} });
      callback(response);
      response.emit("data", JSON.stringify({ balance_infos: [
        { currency: "CNY", total_balance: "12.5", granted_balance: "2", topped_up_balance: "10.5" },
      ] }));
      response.emit("end");
    });
    return request;
  }) as unknown as typeof httpsModule.request;
  t.after(() => { httpsModule.request = originalRequest; });

  const quota = await fetchQuotaAdapter(DEEPSEEK_QUOTA_ADAPTER, "TEST-ONLY-KEY", DEEPSEEK_QUOTA_ADAPTER.providerBaseURL);
  assert.equal(requestUrl, DEEPSEEK_QUOTA_ADAPTER.endpoint);
  assert.equal(authorization, "Bearer TEST-ONLY-KEY");
  assert.deepEqual(quota, [{ label: "CNY", remainingAmount: 12.5, currency: "CNY", grantedAmount: 2, toppedUpAmount: 10.5 }]);
});

test("the built-in Kimi preset uses the same generic request and mapping function", async t => {
  const originalRequest = httpsModule.request;
  let requestUrl = "";
  let authorization = "";
  httpsModule.request = ((input: string | URL, options: { headers?: Record<string, string> }, callback: (response: unknown) => void) => {
    requestUrl = String(input);
    authorization = options.headers?.Authorization ?? "";
    const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    request.destroy = () => {};
    request.end = () => process.nextTick(() => {
      const response = new EventEmitter();
      Object.assign(response, { statusCode: 200, resume: () => {} });
      callback(response);
      response.emit("data", JSON.stringify({ code: 0, data: {
        available_balance: 49.58894,
        voucher_balance: 46.58893,
        cash_balance: 3.00001,
      }, scode: "0x0", status: true }));
      response.emit("end");
    });
    return request;
  }) as unknown as typeof httpsModule.request;
  t.after(() => { httpsModule.request = originalRequest; });

  const quota = await fetchQuotaAdapter(KIMI_QUOTA_ADAPTER, "TEST-ONLY-KEY", KIMI_QUOTA_ADAPTER.providerBaseURL);
  assert.equal(requestUrl, KIMI_QUOTA_ADAPTER.endpoint);
  assert.equal(authorization, "Bearer TEST-ONLY-KEY");
  assert.deepEqual(quota, [{ label: "Kimi API", remainingAmount: 49.58894, currency: "CNY", grantedAmount: 46.58893 }]);
});

test("quota adapters combine same-origin API responses and calculate remaining budget", () => {
  const config = {
    id: "test-budget",
    providerId: "custom-provider",
    displayName: "Monthly budget",
    auth: "bearer",
    requests: [
      { id: "usage", endpoint: "https://quota.example.test/v1/usage" },
      { id: "plan", endpoint: "https://quota.example.test/v1/plan" },
    ],
    fields: [{
      label: "Monthly budget",
      currency: "USD",
      budgetCalculation: {
        limitPath: "/plan/limit_usd",
        usedPath: "/usage/used_cents",
        limitDivisor: 100,
        usedDivisor: 100,
      },
    }],
  };
  assert.deepEqual(mapQuotaResponse({
    usage: { used_cents: 2450 },
    plan: { limit_usd: 2500 },
  }, config), [{
    label: "Monthly budget",
    remainingPercent: 2,
    usedPercent: 98,
    remainingAmount: 0.5,
    currency: "USD",
  }]);
  assert.deepEqual(mapQuotaResponse({ usage: { used_cents: 3000 }, plan: { limit_usd: 2500 } }, config), [{
    label: "Monthly budget",
    remainingPercent: 0,
    usedPercent: 100,
    remainingAmount: 0,
    currency: "USD",
  }]);
});

test("quota adapter validation rejects credential-bearing URLs, unsafe HTTP and unsafe pointers", () => {
  assert.equal(validateQuotaAdapter(adapter).apiKeySource, "secretStorage", "existing settings keep their original key source by default");
  assert.throws(() => validateQuotaAdapter({ ...adapter, endpoint: "https://quota.example.test/?api_key=secret" }));
  assert.throws(() => validateQuotaAdapter({ ...adapter, endpoint: "http://quota.example.test/usage" }));
  assert.throws(() => validateQuotaAdapter({ ...adapter, endpoint: "http://localhost:3030/usage" }));
  assert.throws(() => validateQuotaAdapter({ ...adapter, providerBaseURL: "https://user:pass@example.test" }));
  assert.throws(() => validateQuotaAdapter({
    id: "multi-provider", providerId: "custom", displayName: "Quota", auth: "bearer",
    requests: [
      { id: "first", endpoint: "https://one.example.test/usage" },
      { id: "second", endpoint: "https://two.example.test/plan" },
    ],
    fields: [{ label: "Quota", remainingCountPath: "/first/remaining" }],
  }));
  assert.throws(() => validateQuotaAdapter({
    id: "multi-provider", providerId: "custom", displayName: "Quota", auth: "bearer",
    requests: [
      { id: "same", endpoint: "https://one.example.test/usage" },
      { id: "same", endpoint: "https://one.example.test/plan" },
    ],
    fields: [{ label: "Quota", remainingCountPath: "/same/remaining" }],
  }));
  assert.throws(() => validateQuotaAdapter({ ...adapter, fields: [{ label: "Quota", remainingCountPath: "/__proto__/x" }] }));
  assert.throws(() => validateQuotaAdapter({ ...adapter, requestHeaders: { Authorization: "override" } }));
  assert.equal(quotaSecretStorageKey("test-provider"), "zcode.quotaAdapter.test-provider");
  assert.throws(() => quotaSecretStorageKey("../credential"));
});

test("reused ZCode keys are bound to the exact provider HTTPS host", async () => {
  const config = {
    ...adapter,
    apiKeySource: "zcode",
    requests: [
      { id: "usage", endpoint: "https://quota.example.test/v1/usage" },
      { id: "plan", endpoint: "https://quota.example.test/v1/plan" },
    ],
    endpoint: undefined,
    itemsPath: undefined,
  };
  assert.equal(quotaEndpointsMatchProvider(config, "http://quota.example.test/v1"), true, "allow the provider's HTTP base URL to upgrade to HTTPS on the default port");
  assert.equal(quotaEndpointsMatchProvider(config, "https://other.example.test/v1"), false);
  assert.equal(quotaEndpointsMatchProvider(config, "https://quota.example.test:8443/v1"), false);
  assert.equal(quotaEndpointsMatchProvider({ ...config, requests: [{ id: "usage", endpoint: "https://quota.example.test:8443/v1/usage" }, { id: "plan", endpoint: "https://quota.example.test:8443/v1/plan" }] }, "https://quota.example.test:8443/v1"), true);
  await assert.rejects(fetchQuotaAdapter(config, "TEST-ONLY-KEY"), /untrusted-provider-origin/);
  await assert.rejects(fetchQuotaAdapter(config, "TEST-ONLY-KEY", "https://other.example.test/v1"), /untrusted-provider-origin/);
});

test("generic API keys are sent only in configured authentication headers and not logged in errors", async t => {
  const originalRequest = httpsModule.request;
  let sentHeaders: Record<string, string> | undefined;
  httpsModule.request = ((url: string | URL, options: { headers?: Record<string, string> }, callback: (response: unknown) => void) => {
    sentHeaders = options.headers;
    const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    request.destroy = () => {};
    request.end = () => process.nextTick(() => {
      const response = new EventEmitter();
      Object.assign(response, { statusCode: 200, resume: () => {} });
      callback(response);
      response.emit("data", JSON.stringify({ data: { limits: [{ name: "Fast", remaining_ratio: 0.4 }] } }));
      response.emit("end");
    });
    return request;
  }) as unknown as typeof httpsModule.request;
  t.after(() => { httpsModule.request = originalRequest; });

  const result = await fetchQuotaAdapter(adapter, "TEST-ONLY-KEY");
  assert.deepEqual(result, [{ label: "Fast", remainingPercent: 40, usedPercent: 60 }]);
  assert.equal(sentHeaders?.["x-api-key"], "TEST-ONLY-KEY");
  assert.equal(JSON.stringify(result).includes("TEST-ONLY-KEY"), false);

  await fetchQuotaAdapter({ ...adapter, authHeaderName: "Authorization", authHeaderPrefix: "Token " }, "SECOND-TEST-KEY");
  assert.equal(sentHeaders?.Authorization, "Token SECOND-TEST-KEY");
  assert.throws(() => validateQuotaAdapter({ ...adapter, authHeaderName: "Authorization", authHeaderPrefix: "Token\r\nInjected: yes" }), /invalid-config/);
});

test("POST adapters send only their fixed JSON body", async t => {
  const originalRequest = httpsModule.request;
  let requestMethod = "";
  let requestBody = "";
  httpsModule.request = ((_url: string | URL, options: { method?: string }, callback: (response: unknown) => void) => {
    requestMethod = options.method ?? "";
    const request = new EventEmitter() as EventEmitter & { end: (body?: string) => void; destroy: () => void };
    request.destroy = () => {};
    request.end = body => {
      requestBody = body ?? "";
      process.nextTick(() => {
        const response = new EventEmitter();
        Object.assign(response, { statusCode: 200, resume: () => {} });
        callback(response);
        response.emit("data", JSON.stringify({ available: 8 }));
        response.emit("end");
      });
    };
    return request;
  }) as unknown as typeof httpsModule.request;
  t.after(() => { httpsModule.request = originalRequest; });

  const result = await fetchQuotaAdapter({
    ...adapter,
    method: "POST",
    auth: "none",
    body: { scope: "account", include: ["weekly"] },
    itemsPath: "",
    fields: [{ label: "Available", remainingCountPath: "/available" }],
  });
  assert.equal(requestMethod, "POST");
  assert.equal(requestBody, JSON.stringify({ scope: "account", include: ["weekly"] }));
  assert.deepEqual(result, [{ label: "Available", remainingCount: 8 }]);
});

test("multi-request quota adapters send one protected key to each same-origin endpoint", async t => {
  const originalRequest = httpsModule.request;
  const paths: string[] = [];
  const authHeaders: string[] = [];
  httpsModule.request = ((url: string | URL, options: { headers?: Record<string, string> }, callback: (response: unknown) => void) => {
    const pathname = new URL(String(url)).pathname;
    paths.push(pathname);
    authHeaders.push(options.headers?.Authorization ?? "");
    const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    request.destroy = () => {};
    request.end = () => process.nextTick(() => {
      const response = new EventEmitter();
      Object.assign(response, { statusCode: 200, resume: () => {} });
      callback(response);
      const payload = pathname.endsWith("/usage") ? { used: 1250 } : { limit: 20 };
      response.emit("data", JSON.stringify(payload));
      response.emit("end");
    });
    return request;
  }) as unknown as typeof httpsModule.request;
  t.after(() => { httpsModule.request = originalRequest; });

  const result = await fetchQuotaAdapter({
    id: "test-multi-request",
    providerId: "custom-provider",
    displayName: "Monthly budget",
    auth: "bearer",
    requests: [
      { id: "usage", endpoint: "https://quota.example.test/v1/usage" },
      { id: "plan", endpoint: "https://quota.example.test/v1/plan" },
    ],
    fields: [{
      label: "Monthly budget",
      currency: "USD",
      budgetCalculation: { limitPath: "/plan/limit", usedPath: "/usage/used", usedDivisor: 100 },
    }],
  }, "TEST-ONLY-KEY");
  assert.deepEqual(paths.sort(), ["/v1/plan", "/v1/usage"]);
  assert.deepEqual(authHeaders, ["Bearer TEST-ONLY-KEY", "Bearer TEST-ONLY-KEY"]);
  assert.deepEqual(result, [{ label: "Monthly budget", remainingPercent: 37.5, usedPercent: 62.5, remainingAmount: 7.5, currency: "USD" }]);
  assert.equal(JSON.stringify(result).includes("TEST-ONLY-KEY"), false);
});
