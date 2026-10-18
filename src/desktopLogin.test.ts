import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPersonalShortcutPicker,
  buildPersonalShortcutPickerState,
  localLoginCanOverlapSpawn,
  mergePickerModels,
  readPlanSelection,
  resolvePickerModels,
  sameDesktopLogin,
} from "./desktop";
import type { PickerModel, ResolvedRuntime } from "./desktop";
import type { V2Settings } from "./credentials";

const teamRuntime: Pick<ResolvedRuntime, "providerId" | "apiKey" | "source"> = {
  providerId: "builtin:bigmodel-coding-plan",
  apiKey: "team-key",
  source: "desktop-team-oauth",
};

const teamSettings: V2Settings = {
  providerFamilyDomain: "bigmodel",
  modelProviderFamilyModes: { bigmodel: "oauth" },
  providerFamilyConnectionSelections: {
    bigmodel: { kind: "team-coding-plan", organizationId: "org-1", projectId: "proj_1" },
  },
};

test("personal provider shortcuts contribute keyed models without exposing credentials", () => {
  const shortcuts = buildPersonalShortcutPicker({
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "deepseek",
            providerName: "DeepSeek",
            templateId: "deepseek",
            config: {
              access: { type: "api-key", apiKey: "TEST-SECRET-DO-NOT-RETURN" },
              modelOrder: ["deepseek-flash", "deepseek-v4-pro"],
              personalModelIds: ["custom-model", "deepseek-flash"],
            },
          },
          {
            providerId: "empty-key",
            providerName: "Empty key",
            config: {
              access: { type: "api-key", apiKey: " " },
              modelOrder: ["not-available"],
            },
          },
          {
            providerId: "hidden-provider",
            providerName: "Hidden provider",
            config: {
              access: { type: "api-key", apiKey: "TEST-SECRET" },
              visibility: "hidden",
              modelOrder: ["hidden-model"],
            },
          },
        ],
      },
    },
  });

  assert.deepEqual(shortcuts.map(model => [model.providerId, model.modelId]), [
    ["deepseek", "deepseek-flash"],
    ["deepseek", "deepseek-v4-pro"],
    ["deepseek", "custom-model"],
  ]);
  assert.equal(shortcuts.every(model => model.hasKey), true);
  assert.equal(JSON.stringify(shortcuts).includes("TEST-SECRET"), false);

  const configured: PickerModel[] = [{
    providerId: "deepseek",
    providerName: "Config DeepSeek",
    kind: "openai-compatible",
    modelId: "deepseek-flash",
    label: "deepseek-flash",
    hasKey: true,
  }];
  const merged = mergePickerModels(configured, shortcuts);
  assert.deepEqual(
    merged.map(model => model.modelId),
    ["deepseek-flash", "deepseek-v4-pro", "custom-model"]
  );
  assert.equal(merged[0].providerName, "Config DeepSeek", "existing config metadata should win duplicates");
});

test("OAuth account models stay available while shortcut providers remain authoritative", () => {
  const state = buildPersonalShortcutPickerState({
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "account:bigmodel-team-coding-plan",
            config: {
              modelOrder: ["GLM-5.3", "GLM-5.3-Flash"],
            },
          },
          {
            providerId: "deepseek",
            providerName: "DeepSeek",
            templateId: "deepseek",
            config: {
              access: { type: "api-key", apiKey: "TEST-ONLY-KEY" },
              modelOrder: ["deepseek-flash"],
            },
          },
        ],
      },
    },
  });

  assert.deepEqual(state.models.map(model => [model.providerId, model.modelId]), [["deepseek", "deepseek-flash"]],
    "OAuth account rows must not be exposed as shortcuts without an API key");
  assert.deepEqual(state.managedProviderIds, ["account:bigmodel-team-coding-plan", "deepseek"],
    "both account and shortcut providers must reject unconfigured live catalog models");

  const resolved = resolvePickerModels([
    { providerId: "account:bigmodel-team-coding-plan", providerName: "BigModel Team", kind: "anthropic", modelId: "GLM-5.3", label: "GLM-5.3", hasKey: true },
    { providerId: "account:bigmodel-team-coding-plan", providerName: "BigModel Team", kind: "anthropic", modelId: "GLM-5.3-Flash", label: "GLM-5.3-Flash", hasKey: true },
    { providerId: "deepseek", providerName: "DeepSeek", kind: "openai-compatible", modelId: "removed-deepseek-model", label: "removed-deepseek-model", hasKey: true },
  ], state);
  assert.deepEqual(resolved.picker.map(model => [model.providerId, model.modelId]), [
    ["account:bigmodel-team-coding-plan", "GLM-5.3"],
    ["account:bigmodel-team-coding-plan", "GLM-5.3-Flash"],
    ["deepseek", "deepseek-flash"],
  ], "keep official OAuth models but prune stale configured API shortcut models");
});

test("removed desktop providers are pruned from stale config while current account and builtin models remain", () => {
  const state = buildPersonalShortcutPickerState({
    config: {
      providerConfigRules: {
        providerRules: [{
          providerId: "active-third-party",
          providerName: "Active provider",
          config: {
            access: { type: "api-key", apiKey: "TEST-ONLY-KEY" },
            modelOrder: ["active-model"],
          },
        }],
      },
    },
  });

  const resolved = resolvePickerModels([
    { providerId: "removed-sample-provider", providerName: "Removed sample provider", kind: "openai-compatible", modelId: "sample-model", label: "sample-model", hasKey: true },
    { providerId: "active-third-party", providerName: "Active provider", kind: "openai-compatible", modelId: "stale-model", label: "stale-model", hasKey: true },
    { providerId: "account:bigmodel-team-coding-plan", providerName: "BigModel Team", kind: "anthropic", modelId: "GLM-5.3", label: "GLM-5.3", hasKey: true },
    { providerId: "builtin:bigmodel", providerName: "BigModel API", kind: "openai-compatible", modelId: "GLM-5.3", label: "GLM-5.3", hasKey: true },
  ], state);

  assert.equal(state.providerInventoryAuthoritative, true);
  assert.deepEqual(resolved.picker.map(model => [model.providerId, model.modelId]), [
    ["active-third-party", "active-model"],
    ["account:bigmodel-team-coding-plan", "GLM-5.3"],
    ["builtin:bigmodel", "GLM-5.3"],
  ], "a removed third-party provider and stale models are omitted, without pruning the account provider flows");
});

test("legacy desktop config without a provider registry keeps configured providers", () => {
  const state = buildPersonalShortcutPickerState({ config: {} });
  assert.equal(state.providerInventoryAuthoritative, false);

  const resolved = resolvePickerModels([
    { providerId: "legacy-custom", providerName: "Legacy custom", kind: "openai-compatible", modelId: "legacy-model", label: "legacy-model", hasKey: true },
  ], state);
  assert.deepEqual(resolved.picker.map(model => [model.providerId, model.modelId]), [["legacy-custom", "legacy-model"]]);
});

test("personal shortcut picker excludes disabled template models and honors provider overrides", () => {
  const providerConfig = {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "moonshot-kimi",
            providerName: "Kimi",
            templateId: "moonshot-kimi",
            config: {
              access: { type: "api-key", apiKey: "TEST-ONLY-KIMI-KEY" },
              modelOrder: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.7-code-highspeed", "k3", "k3-256k"],
              personalModelIds: ["my-kimi-model"],
            },
          },
          {
            providerId: "disabled-provider",
            providerName: "Disabled provider",
            enabled: false,
            templateId: "moonshot-kimi",
            config: { access: { type: "api-key", apiKey: "TEST-ONLY-KEY" }, modelOrder: ["kimi-k3"] },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [
          { providerId: "moonshot-kimi", modelId: "kimi-k3", config: { enabled: false } },
          { providerId: "moonshot-kimi", modelId: "k3", config: { enabled: true } },
        ],
        manualProviderModelRules: [],
      },
    },
  };
  const builtinConfig = {
    config: {
      modelConfigRules: {
        templateModelRules: [
          { templateId: "moonshot-kimi", modelId: "kimi-k3", config: { enabled: true } },
          { templateId: "moonshot-kimi", modelId: "kimi-k2.7-code", config: { enabled: true } },
          { templateId: "moonshot-kimi", modelId: "kimi-k2.6", config: { enabled: true } },
          { templateId: "moonshot-kimi", modelId: "kimi-k2.7-code-highspeed", config: { enabled: false } },
          { templateId: "moonshot-kimi", modelId: "k3", config: { enabled: false } },
          { templateId: "moonshot-kimi", modelId: "k3-256k", config: { enabled: false } },
        ],
      },
    },
  };
  const state = buildPersonalShortcutPickerState(providerConfig, builtinConfig);

  assert.deepEqual(state.models.map(model => [model.providerId, model.modelId]), [
    ["moonshot-kimi", "kimi-k2.7-code"],
    ["moonshot-kimi", "kimi-k2.6"],
    ["moonshot-kimi", "k3"],
    ["moonshot-kimi", "my-kimi-model"],
  ]);
  assert.deepEqual(state.disabledModelKeys, [
    "moonshot-kimi\0kimi-k3",
    "moonshot-kimi\0kimi-k2.7-code-highspeed",
    "moonshot-kimi\0k3-256k",
    "disabled-provider\0kimi-k3",
  ]);
  assert.equal(JSON.stringify(state).includes("TEST-ONLY"), false);
});

test("shortcut-only models stay together with the same configured provider", () => {
  const sampleVendorModels: PickerModel[] = [
    {
      providerId: "sampleVendor",
      providerName: "sampleVendor",
      kind: "openai-compatible",
      modelId: "glm-5.2",
      label: "glm-5.2",
      hasKey: true,
    },
    {
      providerId: "another-provider",
      providerName: "Another provider",
      kind: "openai-compatible",
      modelId: "another-model",
      label: "another-model",
      hasKey: true,
    },
  ];
  const shortcutModels: PickerModel[] = [{
    providerId: "sampleVendor",
    providerName: "sampleVendor",
    kind: "unknown",
    modelId: "kimi-k3",
    label: "kimi-k3",
    hasKey: true,
  }];

  const merged = mergePickerModels(sampleVendorModels, shortcutModels);
  assert.deepEqual(merged.map(model => [model.providerName, model.modelId]), [
    ["sampleVendor", "glm-5.2"],
    ["sampleVendor", "kimi-k3"],
    ["Another provider", "another-model"],
  ]);
});

test("the builtin team login matches the session account id", () => {
  assert.equal(sameDesktopLogin(teamRuntime, "account:bigmodel-team-coding-plan"), true);
  assert.equal(sameDesktopLogin(teamRuntime, "account:bigmodel-individual-coding-plan"), false);
  assert.equal(sameDesktopLogin(teamRuntime, "account:zai-team-coding-plan"), false);
  assert.equal(sameDesktopLogin({ ...teamRuntime, apiKey: "" }, "builtin:bigmodel-coding-plan"), false);
});

test("a personal login is not reused for a team session", () => {
  const personal = { ...teamRuntime, source: "desktop-personal-oauth" as const };
  assert.equal(sameDesktopLogin(personal, "account:bigmodel-individual-coding-plan"), true);
  assert.equal(sameDesktopLogin(personal, "account:bigmodel-team-coding-plan"), false);
  assert.equal(sameDesktopLogin(
    { providerId: "builtin:bigmodel-start-plan", apiKey: "start-key", source: "desktop-personal-oauth" },
    "account:bigmodel-start-plan"
  ), true);
});

for (const family of ["bigmodel", "zai"] as const) {
  test(`${family} login resolves individual, team and Start Plan selections independently`, () => {
    const base: V2Settings = {
      providerFamilyDomain: family,
      modelProviderFamilyModes: { [family]: "oauth" },
    };
    assert.deepEqual(readPlanSelection(base), {
      family,
      kind: "individual-coding-plan",
      providerId: `builtin:${family}-coding-plan`,
    });
    assert.deepEqual(readPlanSelection({
      ...base,
      providerFamilyConnectionSelections: {
        [family]: { kind: "team-coding-plan", organizationId: "org-current", projectId: "project-current" },
      },
    }), {
      family,
      kind: "team-coding-plan",
      team: { organizationId: "org-current", projectId: "project-current" },
      providerId: `builtin:${family}-coding-plan`,
    });
    assert.deepEqual(readPlanSelection({
      ...base,
      providerFamilyConnectionSelections: { [family]: { kind: "start-plan" } },
    }), {
      family,
      kind: "start-plan",
      providerId: `builtin:${family}-start-plan`,
    });
    assert.equal(readPlanSelection({
      ...base,
      modelProviderFamilyModes: { [family]: "apiKey" },
    }), null, "API-key mode must not be mistaken for an account Coding Plan");
  });
}

test("spawn overlaps the plan exchange only when an access token is already stored", () => {
  const creds = { "oauth:bigmodel:access_token": "present" };
  assert.equal(localLoginCanOverlapSpawn({ settings: teamSettings, credentials: creds }), true);
  assert.equal(localLoginCanOverlapSpawn({ settings: teamSettings, credentials: {} }), false);
  assert.equal(localLoginCanOverlapSpawn({
    settings: teamSettings,
    credentials: creds,
    preferredProviderId: "custom-provider",
  }), false);
});

test("desktop inventory keeps its last verified state during failed reads and recovers on the next save", async () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const {readPickerResolution, isSessionModelAvailable} = await import("./desktop");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-inventory-"));
  const original = os.homedir;
  os.homedir = () => home;
  const dir = path.join(home,".zcode","v2"); fs.mkdirSync(dir,{recursive:true});
  const registry = path.join(dir,"provider_config.json");
  const model = {providerId:"sample",modelId:"model"};
  const enabled = {schemaVersion:1,config:{providerConfigRules:{providerRules:[{
    providerId:"sample",enabled:true,providerName:"Sample",config:{access:{type:"api-key",apiKey:"TEST-ONLY"},api:{type:"openai-chat-completions",baseUrl:"https://example.test/v1"},personalModelIds:["model"],modelOrder:["model"]}
  }]},modelConfigRules:{providerModelRules:[{providerId:"sample",modelId:"model",config:{enabled:true}}]}}};
  fs.writeFileSync(path.join(dir,"config.json"), JSON.stringify({provider:{sample:{name:"Sample",kind:"openai-compatible",options:{apiKey:"TEST-ONLY",baseURL:"https://example.test/v1"},models:{model:{}}}}}));
  const save = (value:unknown) => fs.writeFileSync(registry,JSON.stringify(value));
  try {
    save(enabled); assert.equal(await isSessionModelAvailable(model),true);
    for (const change of ["model", "provider", "remove"]) {
      const disabled = structuredClone(enabled);
      if (change === "model") disabled.config.modelConfigRules.providerModelRules[0].config.enabled=false;
      else if (change === "provider") disabled.config.providerConfigRules.providerRules[0].enabled=false;
      else disabled.config.providerConfigRules.providerRules=[];
      save(disabled); assert.equal(await isSessionModelAvailable(model),false,change);
      const verified = await readPickerResolution();
      fs.writeFileSync(registry,"{");
      const broken = await readPickerResolution();
      assert.deepEqual(broken,verified,"failed reads resurrected a stale configured model");
      assert.equal(await isSessionModelAvailable(model),false);
      save(enabled); assert.equal(await isSessionModelAvailable(model),true,"healthy save was ignored");
    }
    // A different profile with no registry must not inherit the previous profile.
    os.homedir = () => path.join(home,"other");
    assert.equal((await readPickerResolution()).providerInventoryAuthoritative,false);
  } finally {os.homedir=original;fs.rmSync(home,{recursive:true,force:true});}
});
