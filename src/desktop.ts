import { hostT as t } from "./hostI18n";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  OrgProject,
  PlanAuth,
  usesProjectTokens,
  PlanFamily,
  V2Config,
  V2Provider,
  V2Settings,
  cliDir,
  hasPlanOAuthToken,
  maybeDecryptSecret,
  readStoredPlanApiKey,
  readStoredPlanApiKeyWithRetry,
  readV2ConfigWithRetry,
  readV2SettingsWithRetry,
  readV2Config,
  readV2Settings,
  tryPlanOAuth,
  zcodeDir,
} from "./credentials";
import { readDesktopJson, readDesktopJsonWithRetry } from "./desktopJson";
import { logInfo, logWarn } from "./log";

export interface ResolvedRuntime {
  providerId: string;
  providerName: string;
  kind: string;
  baseURL: string;
  apiKey: string;
  /** Non-secret key ID marks a memory-only project access token. */
  apiKeyId?: string;
  modelId: string;
  models: Record<string, unknown>;
  source:
    | "desktop-team-oauth"
    | "desktop-personal-oauth"
    | "desktop-apikey"
    | "custom-provider"
    | "vscode-override";
}

export interface PickerModel {
  providerId: string;
  providerName: string;
  kind: string;
  modelId: string;
  label: string;
  hasKey: boolean;
  disabledReason?: string;
}

export interface ResolveResult {
  ok: boolean;
  runtime?: ResolvedRuntime;
  reason?: string;
  hint?: string;
  picker: PickerModel[];
  /** Shortcut models explicitly disabled by the desktop, including live backend choices. */
  disabledModelKeys?: string[];
  /** Provider IDs currently present in the desktop provider registry. */
  managedProviderIds?: string[];
  /** True only when provider_config.json has a readable provider registry. */
  providerInventoryAuthoritative?: boolean;
  warning?: string;
  /** True when this call listed or copied a plan key over the network. */
  exchangedLogin?: boolean;
}

interface TeamPlanRef {
  providerId: string;
  organizationId: string;
  projectId: string;
  product?: string;
}

const DEFAULT_ANTHROPIC = "https://open.bigmodel.cn/api/anthropic";

export type PlanKind = "individual-coding-plan" | "team-coding-plan" | "start-plan";

export interface PlanSelection {
  family: PlanFamily;
  kind: PlanKind;
  /** Set only for a team plan. Personal and start plans omit it. */
  team?: OrgProject;
  providerId: string;
}

function isPlanFamily(domain: string | undefined): domain is PlanFamily {
  return domain === "bigmodel" || domain === "zai";
}

function builtinPlanProviderId(family: PlanFamily, kind: PlanKind): string {
  if (kind === "start-plan") return `builtin:${family}-start-plan`;
  return `builtin:${family}-coding-plan`;
}

export function resolveBinaryPath(configured?: string): string {
  const extra: string[] = [];
  if (process.platform === "darwin") {
    extra.push(
      "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
      path.join(
        os.homedir(),
        "Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"
      )
    );
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? "";
    extra.push(
      path.join(local, "Programs", "ZCode", "resources", "glm", "zcode.cjs")
    );
  }
  if (process.platform === "linux") {
    extra.push(
      "/opt/ZCode/resources/glm/zcode.cjs",
      "/usr/lib/zcode/resources/glm/zcode.cjs",
      path.join(os.homedir(), ".local/share/ZCode/resources/glm/zcode.cjs")
    );
  }

  const candidates = [configured, ...extra].filter(
    (p): p is string => !!p && p.length > 0
  );
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return configured || candidates.find((c) => c !== configured) || "";
}

export function workspaceObject(workspacePath: string): {
  workspaceKey: string;
  workspacePath: string;
} {
  return { workspaceKey: workspacePath, workspacePath };
}

function findBundledBuiltinProvider(binaryPath: string): string | undefined {
  const dir = path.dirname(path.resolve(binaryPath));
  const candidates = [
    path.join(dir, "provider", "zcode-builtin.json"),
    path.join(dir, "..", "config", "provider", "zcode-builtin.json"),
    path.join(dir, "..", "..", "config", "provider", "zcode-builtin.json"),
  ];
  return candidates.find((c) => fs.existsSync(c));
}

function findActiveBuiltinProvider(): string | undefined {
  const root = path.join(os.homedir(), ".zcode", "v2", "runtime", "provider");
  if (!fs.existsSync(root)) return undefined;
  const found: { file: string; mtime: number }[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name === "zcode-builtin.json") {
        try {
          found.push({ file: full, mtime: fs.statSync(full).mtimeMs });
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(root);
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0]?.file;
}

/** Env required by current ZCode app-server to locate built-in provider config. */
export function appServerEnv(binaryPath: string): Record<string, string> {
  const bundled = findBundledBuiltinProvider(binaryPath);
  const active = findActiveBuiltinProvider() ?? bundled;
  const personal = path.join(os.homedir(), ".zcode", "v2", "provider_config.json");
  const env: Record<string, string> = {};
  if (active) env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = active;
  if (bundled) env.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE = bundled;
  env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personal;
  return env;
}

/** Context window from the same model rules the desktop uses for the circle. */
export function modelContextWindow(providerId: string, modelId: string): number | null {
  const configured = configuredModelContext(providerId, modelId);
  if (configured) return configured;
  return builtinModelContextWindow(modelId);
}

function configuredModelContext(providerId: string, modelId: string): number | null {
  const model = readV2Config()?.provider?.[providerId]?.models?.[modelId] as
    | { limit?: { context?: number } }
    | undefined;
  const context = model?.limit?.context;
  return typeof context === "number" && context > 0 ? context : null;
}

let builtinWindowRules: { file: string; mtime: number; rules: ModelWindowRule[] } | null = null;

interface ModelWindowRule {
  modelMatch: string;
  contextWindow?: number;
}

function builtinModelContextWindow(modelId: string): number | null {
  const file =
    findActiveBuiltinProvider() ?? findBundledBuiltinProvider(resolveBinaryPath());
  if (!file || !fs.existsSync(file)) return null;
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  if (!builtinWindowRules || builtinWindowRules.file !== file || builtinWindowRules.mtime !== mtime) {
    builtinWindowRules = { file, mtime, rules: loadModelWindowRules(file) };
  }
  let window: number | undefined;
  for (const rule of builtinWindowRules.rules) {
    if (!rule.contextWindow) continue;
    try {
      if (new RegExp(`^(?:${rule.modelMatch})$`, "i").test(modelId)) {
        window = rule.contextWindow;
      }
    } catch {
      /* skip invalid modelMatch */
    }
  }
  return window ?? null;
}

function loadModelWindowRules(file: string): ModelWindowRule[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      config?: { modelConfigRules?: { modelRules?: ModelWindowRule[] } };
      modelConfigRules?: { modelRules?: ModelWindowRule[] };
    };
    const rules =
      parsed.config?.modelConfigRules?.modelRules ??
      parsed.modelConfigRules?.modelRules ??
      [];
    return rules.map((rule) => ({
      modelMatch: rule.modelMatch,
      contextWindow: (rule as { config?: { properties?: { contextWindow?: number } } }).config
        ?.properties?.contextWindow,
    }));
  } catch {
    return [];
  }
}

function currentAccountProviderId(): string {
  const settings = readV2Settings();
  const domain = settings?.providerFamilyDomain || "";
  const kind = domain
    ? settings?.providerFamilyConnectionSelections?.[domain]?.kind || ""
    : "";
  if (
    domain &&
    (kind === "team-coding-plan" ||
      kind === "individual-coding-plan" ||
      kind === "start-plan")
  ) {
    return `account:${domain}-${kind}`;
  }
  try {
    const cli = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".zcode", "cli", "config.json"), "utf8")
    ) as { model?: string };
    const m = String(cli.model || "");
    const slash = m.lastIndexOf("/");
    if (slash > 0 && m.startsWith("account:")) return m.slice(0, slash);
  } catch {
    /* ignore */
  }
  return "";
}

function loadBuiltinProviderRules(binaryPath: string): Array<{
  providerId: string;
  providerName: string;
  builtinModelIds: string[];
  accessType: string;
  accountType: string;
  mode: string;
  baseUrl: string;
  hidden: boolean;
}> {
  const active = appServerEnv(binaryPath).ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  if (!active || !fs.existsSync(active)) return [];
  try {
    const builtin = JSON.parse(fs.readFileSync(active, "utf8")) as {
      config?: {
        providerConfigRules?: {
          providerRules?: Array<{
            providerId?: string;
            providerName?: string;
            config?: {
              builtinModelIds?: string[];
              visibility?: string;
              access?: { type?: string; mode?: string; accountType?: string };
              api?: { baseUrl?: string };
            };
          }>;
        };
      };
    };
    const rules = builtin.config?.providerConfigRules?.providerRules ?? [];
    return rules
      .filter((r) => !!r.providerId)
      .map((r) => ({
        providerId: String(r.providerId),
        providerName: r.providerName || String(r.providerId),
        builtinModelIds: r.config?.builtinModelIds ?? [],
        accessType: r.config?.access?.type || "zhipu-account",
        accountType: r.config?.access?.accountType || "",
        mode: r.config?.access?.mode || "",
        baseUrl: r.config?.api?.baseUrl || "",
        hidden: r.config?.visibility === "hidden",
      }));
  } catch {
    return [];
  }
}

/** Overlay that entitles ZCode built-in account providers in this app-server process. */
export function buildAccountProviderSync(binaryPath: string): {
  revision: string;
  basedOnZCodeBuiltinRevision: string;
  providers: Record<string, unknown>;
  states: Record<string, unknown>;
} | null {
  const active = appServerEnv(binaryPath).ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  if (!active || !fs.existsSync(active)) return null;
  let fileRev = "";
  try {
    fileRev = String(JSON.parse(fs.readFileSync(active, "utf8")).revision ?? "");
  } catch {
    return null;
  }
  const hash = crypto.createHash("sha256").update(path.resolve(active)).digest("hex");
  const basedOn = `zcode-builtin:${fileRev}:${hash}`;
  const current = currentAccountProviderId();
  const providers: Record<string, unknown> = {};
  const states: Record<string, unknown> = {};
  for (const rule of loadBuiltinProviderRules(binaryPath)) {
    const active = !rule.hidden && rule.providerId === current;
    providers[rule.providerId] = {
      builtinModelIds: rule.builtinModelIds,
      access: { type: rule.accessType, entitled: active },
    };
    states[rule.providerId] = {
      availability: active ? "available" : "unavailable",
      entitled: active,
      current: active,
    };
  }
  if (Object.keys(providers).length === 0) return null;
  return {
    revision: `vscode:${basedOn}`,
    basedOnZCodeBuiltinRevision: basedOn,
    providers,
    states,
  };
}

function providerApiKey(p: V2Provider | undefined): string {
  return maybeDecryptSecret(p?.options?.apiKey).trim();
}

function pickModelId(provider: V2Provider, preferred?: string): string {
  const keys = Object.keys(provider.models ?? {});
  if (preferred && keys.includes(preferred)) return preferred;
  if (keys.length === 0) return preferred || "";

  const scored = keys.map((k, index) => {
    const meta = provider.models?.[k] as
      | { zcode?: { priority?: number } }
      | undefined;
    const prio = meta?.zcode?.priority ?? 0;
    return { k, s: prio, index };
  });
  scored.sort((a, b) => b.s - a.s || a.index - b.index);
  return scored[0].k;
}

function parseModelOverride(
  raw: string
): { providerId: string; modelId: string } | null {
  const s = raw.trim();
  if (!s) return null;
  const slash = s.lastIndexOf("/");
  if (slash <= 0) return null;
  return { providerId: s.slice(0, slash), modelId: s.slice(slash + 1) };
}

export function isDesktopOauthProvider(providerId: string): boolean {
  return providerId.includes("coding-plan") || providerId.includes("start-plan");
}

/** Fingerprint of the desktop provider-family selection (personal/team/apiKey). */
export function desktopFamilyFingerprint(): string {
  const settings = readV2Settings();
  const domain = settings?.providerFamilyDomain || "";
  const mode = (domain && settings?.modelProviderFamilyModes?.[domain]) || "";
  const selected =
    (domain && settings?.modelProviderFamilySelectedKeys?.[domain]) || "";
  return `${domain}|${mode}|${selected}`;
}

/**
 * Desktop plan currently selected for this family.
 * `null` means API-key mode, a custom provider, or a plan this extension does not quota.
 * An empty kind on an oauth family is the personal coding plan.
 */
export function readPlanSelection(settings: V2Settings | null = readV2Settings()): PlanSelection | null {
  const domain = settings?.providerFamilyDomain;
  if (!isPlanFamily(domain)) return null;
  const mode = settings?.modelProviderFamilyModes?.[domain] ?? "oauth";
  if (mode === "apiKey") return null;
  const selection = settings?.providerFamilyConnectionSelections?.[domain];
  const kind = selection?.kind || "";
  const selected = settings?.modelProviderFamilySelectedKeys?.[domain] || "";
  const parsed = parseTeamPlanKey(selected);
  const teamKind =
    kind === "team-coding-plan" ||
    (parsed !== null && kind !== "individual-coding-plan" && kind !== "start-plan");
  if (teamKind) {
    const organizationId = selection?.organizationId || parsed?.organizationId;
    const projectId = selection?.projectId || parsed?.projectId;
    if (!organizationId || !projectId) return null;
    const fromKey = parsed?.providerId?.startsWith("builtin:") ? parsed.providerId : "";
    return {
      family: domain,
      kind: "team-coding-plan",
      team: { organizationId, projectId },
      providerId: fromKey || builtinPlanProviderId(domain, "team-coding-plan"),
    };
  }
  if (kind === "start-plan") {
    return {
      family: domain,
      kind,
      providerId: builtinPlanProviderId(domain, kind),
    };
  }
  if (kind === "individual-coding-plan" || kind === "") {
    return {
      family: domain,
      kind: "individual-coding-plan",
      providerId: builtinPlanProviderId(domain, "individual-coding-plan"),
    };
  }
  return null;
}

function familyOfProvider(
  providerId: string,
  fallback?: PlanFamily
): PlanFamily | undefined {
  if (providerId.includes("zai-") || providerId.includes(":zai")) return "zai";
  if (providerId.includes("bigmodel")) return "bigmodel";
  return fallback;
}

function kindOfProvider(providerId: string, fallback: PlanKind): PlanKind {
  if (providerId.includes("team-coding-plan")) return "team-coding-plan";
  if (providerId.includes("start-plan")) return "start-plan";
  if (providerId.includes("individual-coding-plan")) return "individual-coding-plan";
  return fallback;
}

/**
 * A session model id and the desktop runtime can name one plan differently:
 * `builtin:bigmodel-coding-plan` and `account:bigmodel-team-coding-plan`.
 * The held key is reusable when the family and plan kind agree.
 */
export function sameDesktopLogin(
  runtime: Pick<ResolvedRuntime, "providerId" | "apiKey" | "source">,
  providerId: string
): boolean {
  if (!runtime.apiKey) return false;
  if (runtime.providerId === providerId) return true;
  if (runtime.source !== "desktop-team-oauth" && runtime.source !== "desktop-personal-oauth") return false;
  const family = familyOfProvider(providerId);
  if (!family || family !== familyOfProvider(runtime.providerId)) return false;
  if (providerId.includes("start-plan") || runtime.providerId.includes("start-plan")) {
    return runtime.source === "desktop-personal-oauth"
      && providerId.includes("start-plan")
      && runtime.providerId.includes("start-plan");
  }
  if (runtime.source === "desktop-team-oauth") {
    return kindOfProvider(providerId, "individual-coding-plan") === "team-coding-plan";
  }
  return kindOfProvider(providerId, "team-coding-plan") === "individual-coding-plan";
}

/** Team and personal plan exchanges can run while the app-server process starts. */
export function localLoginCanOverlapSpawn(opts?: {
  modelOverride?: string;
  preferredProviderId?: string;
  settings?: V2Settings | null;
  credentials?: Record<string, string> | null;
}): boolean {
  const settings = opts?.settings === undefined ? readV2Settings() : opts.settings;
  const credentials = opts && "credentials" in opts ? opts.credentials : undefined;
  const explicit = opts?.preferredProviderId
    || parseModelOverride(opts?.modelOverride ?? "")?.providerId
    || "";
  const family = explicit
    ? (isDesktopOauthProvider(explicit) || explicit.startsWith("account:") ? familyOfProvider(explicit) : undefined)
    : readPlanSelection(settings)?.family;
  if (explicit && !family) return false;
  return !!family && hasPlanOAuthToken(family, credentials);
}

function oauthTarget(
  providerId: string,
  plan: PlanSelection | null,
  parsedTeam: TeamPlanRef | null
): { family: PlanFamily; kind: PlanKind; team?: OrgProject; providerId: string } | null {
  const family = familyOfProvider(providerId, plan?.family);
  if (!family) return null;
  const kind = kindOfProvider(providerId, plan?.kind ?? "individual-coding-plan");
  let team: OrgProject | undefined;
  if (kind === "team-coding-plan") {
    if (plan?.kind === "team-coding-plan" && plan.family === family && plan.team) {
      team = plan.team;
    } else if (parsedTeam) {
      team = {
        organizationId: parsedTeam.organizationId,
        projectId: parsedTeam.projectId,
      };
    }
    if (!team) return null;
  }
  return {
    family,
    kind,
    team,
    providerId: providerId.startsWith("builtin:")
      ? providerId
      : builtinPlanProviderId(family, kind),
  };
}

export function parseTeamPlanKey(key: string): TeamPlanRef | null {
  if (!key.startsWith("team-plan:")) return null;
  const rest = key.slice("team-plan:".length);
  // Keep the org- / proj_ prefixes — BigModel APIs expect them.
  const organizationId = rest.match(/org-[^:]+/)?.[0];
  const projectId = rest.match(/proj_[^:]+/)?.[0];
  const product = rest.match(/product-([^:]+)/)?.[1];
  const providerId = rest.split(":product-")[0] || "";
  if (!organizationId || !projectId || !providerId) return null;
  return { providerId, organizationId, projectId, product };
}

export async function resolveProviderRequestAuth(
  providerId: string, appVersion?: string | null, rejectedFingerprint?: string
): Promise<PlanAuth | null> {
  const plan = readPlanSelection();
  const family = familyOfProvider(providerId, plan?.family);
  if (!family) return null;
  const kind = kindOfProvider(providerId, plan?.kind ?? "individual-coding-plan");
  if (kind === "team-coding-plan") {
    if (!plan?.team || plan.family !== family) return null;
    return tryPlanOAuth(family, plan.team, appVersion, rejectedFingerprint);
  }
  if (!(kind !== "start-plan" && usesProjectTokens(appVersion))) {
    const stored = readStoredPlanApiKey(providerId.startsWith("account:")
      ? providerId : `account:${family}-${kind}`);
    if (stored) return { apiKey: stored };
  }
  return tryPlanOAuth(family, undefined, kind === "start-plan" ? undefined : appVersion, rejectedFingerprint);
}

function productPlanBaseUrl(family: PlanFamily, kind: PlanKind): string {
  if (kind === "start-plan") return "https://zcode.z.ai/api/v1/zcode-plan/anthropic";
  if (family === "zai") return "https://api.z.ai/api/anthropic";
  return DEFAULT_ANTHROPIC;
}

function fallbackPlanProvider(family: PlanFamily, kind: PlanKind): V2Provider {
  const rule = loadBuiltinProviderRules(resolveBinaryPath()).find(
    (item) => item.accountType === family && item.mode === kind && !item.hidden
  );
  const modelIds = (rule?.builtinModelIds ?? []).filter((id) => id.trim());
  return {
    name: rule?.providerName || kind,
    kind: "anthropic",
    options: { baseURL: rule?.baseUrl || productPlanBaseUrl(family, kind) },
    models: Object.fromEntries(modelIds.map((id) => [id, {}])),
  };
}

function toRuntime(
  providerId: string,
  provider: V2Provider,
  modelId: string,
  apiKey: string,
  source: ResolvedRuntime["source"]
): ResolvedRuntime {
  return {
    providerId,
    providerName: provider.name ?? providerId,
    kind: provider.kind ?? "openai-compatible",
    baseURL: provider.options?.baseURL ?? "",
    apiKey,
    modelId,
    models: provider.models ?? {},
    source,
  };
}

/** The CLI default may use an account provider ID distinct from desktop login metadata. */
export function readCliDefaultModel(): { providerId: string; modelId: string } | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(cliDir(), "config.json"), "utf-8"));
    if (typeof raw.model !== "string") return undefined;
    const slash = raw.model.indexOf("/");
    if (slash <= 0 || slash === raw.model.length - 1) return undefined;
    return { providerId: raw.model.slice(0, slash), modelId: raw.model.slice(slash + 1) };
  } catch { return undefined; }
}

export function readConfiguredDefaultModel(runtime: ResolvedRuntime | null): { providerId: string; modelId: string } | undefined {
  const cli = readCliDefaultModel();
  if (cli) return cli;
  // When the CLI has no default yet (common on a fresh Windows install),
  // use the active account's advertised provider rather than its login alias.
  const candidates = buildPicker(readV2Config()).filter(model => !model.disabledReason);
  const preferred = candidates.find(model => model.providerId === runtime?.providerId && model.modelId === runtime?.modelId)
    ?? candidates.find(model => runtime?.source.includes("oauth") && model.providerId.startsWith("account:") && model.modelId === runtime.modelId)
    ?? candidates.find(model => runtime?.source.includes("oauth") && model.providerId.startsWith("account:"));
  return preferred ? {providerId: preferred.providerId, modelId: preferred.modelId} : undefined;
}

export function listStoredProviderModels(): Array<{
  providerId: string;
  modelId: string;
}> {
  const providers = readV2Config()?.provider ?? {};
  const custom: Array<{ providerId: string; modelId: string }> = [];
  const builtin: Array<{ providerId: string; modelId: string }> = [];
  for (const [providerId, provider] of Object.entries(providers)) {
    if (provider.enabled === false) continue;
    const modelId = pickModelId(provider);
    if (!modelId) continue;
    const row = { providerId, modelId };
    if (providerId.startsWith("builtin:")) builtin.push(row);
    else custom.push(row);
  }
  return [...custom, ...builtin];
}

function addProviderModels(
  out: PickerModel[],
  providerId: string,
  provider: V2Provider,
  providerName: string,
  hasKey: boolean,
  disabledReason?: string
): void {
  const modelIds = Object.keys(provider.models ?? {});
  const ids = modelIds.length > 0 ? modelIds : ["(default)"];
  for (const modelId of ids) {
    out.push({
      providerId,
      providerName,
      kind: provider.kind ?? "unknown",
      modelId,
      label: modelId,
      hasKey,
      disabledReason: hasKey ? undefined : disabledReason,
    });
  }
}

export function buildPicker(config: V2Config | null): PickerModel[] {
  const out: PickerModel[] = [];
  const providers = config?.provider ?? {};
  const settings = readV2Settings();
  const domain = settings?.providerFamilyDomain || "";
  const mode = domain ? settings?.modelProviderFamilyModes?.[domain] ?? "oauth" : "";

  if (isPlanFamily(domain) && mode === "apiKey") {
    const providerId = `builtin:${domain}`;
    const api = providers[providerId];
    const hasKey = providerApiKey(api).length > 0;
    if (api && hasKey) {
      addProviderModels(out, providerId, api, api.name || "API key", true);
    }
  }

  for (const [providerId, provider] of Object.entries(providers)) {
    if (providerId.startsWith("builtin:")) continue;
    if (provider.enabled === false) continue;
    const hasKey = providerApiKey(provider).length > 0;
    if (!hasKey) continue;
    addProviderModels(
      out,
      providerId,
      provider,
      provider.name ?? "Custom",
      true
    );
  }

  const oauthReady = isPlanFamily(domain) && hasPlanOAuthToken(domain);
  const activeAccount = currentAccountProviderId();
  if (mode !== "apiKey" && oauthReady && activeAccount) {
    for (const rule of loadBuiltinProviderRules(resolveBinaryPath())) {
      if (rule.hidden || rule.providerId !== activeAccount) continue;
      for (const modelId of rule.builtinModelIds) {
        out.push({
          providerId: rule.providerId,
          providerName: rule.providerName,
          kind: "anthropic",
          modelId,
          label: modelId,
          hasKey: true,
        });
      }
    }
  }
  return out;
}

interface DesktopProviderRule {
  providerId?: string;
  providerName?: string;
  templateId?: string;
  enabled?: boolean;
  config?: {
    access?: { type?: string; apiKey?: string };
    api?: { type?: string; baseUrl?: string };
    modelOrder?: string[];
    personalModelIds?: string[];
    builtinModelIds?: string[];
    visibility?: string;
  };
}

/** Host-only credentials. Never attach these providers to picker/webview data. */
export function mergeDesktopApiProviders(
  legacy: Record<string, V2Provider>, personal: unknown, builtin: unknown
): Record<string, V2Provider> {
  type Registry = { config?: { providerConfigRules?: { providerRules?: DesktopProviderRule[]; templateRules?: Array<DesktopProviderRule & { templateId: string }> } } };
  const rules = (personal as Registry | null)?.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(rules)) return legacy;
  const templates = (builtin as Registry | null)?.config?.providerConfigRules?.templateRules ?? [];
  const providers = { ...legacy };
  const counts = new Map<string, number>();
  for (const rule of rules) {
    if (rule?.providerId) counts.set(rule.providerId, (counts.get(rule.providerId) ?? 0) + 1);
  }
  for (const rule of rules) {
    const id = rule?.providerId;
    if (!id) continue;
    if (counts.get(id) !== 1) { delete providers[id]; continue; }
    const template = templates.find(item => item.templateId === rule.templateId)?.config;
    const access = { ...template?.access, ...rule.config?.access };
    // Account/OAuth providers keep their separate request-time authentication.
    if (access.type !== "api-key" && access.type !== "zhipu-coding-plan-api-key") continue;
    const previous = legacy[id];
    const api = { ...template?.api, ...rule.config?.api };
    const kinds: Record<string, string> = {
      "anthropic-messages": "anthropic", "openai-chat-completions": "openai-compatible", "openai-responses": "openai",
    };
    if (api.type && !kinds[api.type]) { delete providers[id]; continue; }
    const ids = [...(rule.config?.modelOrder ?? []), ...(rule.config?.personalModelIds ?? []), ...(template?.builtinModelIds ?? [])];
    providers[id] = {
      ...previous,
      name: rule.providerName ?? previous?.name ?? id,
      enabled: rule.enabled !== false && rule.config?.visibility !== "hidden",
      kind: api.type ? kinds[api.type] : previous?.kind,
      options: {
        ...previous?.options,
        // A current empty key is a cleared credential, never an old-key fallback.
        apiKey: typeof access.apiKey === "string" ? access.apiKey : "",
        baseURL: api.baseUrl ?? previous?.options?.baseURL,
      },
      models: { ...previous?.models, ...Object.fromEntries([...new Set(ids)].filter(id => typeof id === "string" && id.trim())
        .map(id => [id, previous?.models?.[id] ?? {}])) },
    };
  }
  return providers;
}

async function readRuntimeConfig(): Promise<V2Config | null> {
  const legacy = await readV2ConfigWithRetry();
  const file = path.join(zcodeDir(), "v2", "provider_config.json");
  if (!fs.existsSync(file)) return legacy;
  try {
    const builtinFile = appServerEnv(resolveBinaryPath()).ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    const [personal, builtin] = await Promise.all([
      readDesktopJsonWithRetry<unknown>(file),
      builtinFile ? readDesktopJsonWithRetry<unknown>(builtinFile).catch(() => null) : Promise.resolve(null),
    ]);
    return { ...legacy, provider: mergeDesktopApiProviders(legacy?.provider ?? {}, personal, builtin) };
  } catch {
    // A present but unreadable current registry must not revive stale keys.
    return { ...legacy, provider: {} };
  }
}

/**
 * ZCode desktop shortcuts are stored in provider_config.json, outside the CLI
 * config consumed by buildPicker. Read only model metadata and whether a key is
 * present; never copy or log the credential itself.
 */
export interface PersonalShortcutPickerState {
  models: PickerModel[];
  disabledModelKeys: string[];
  managedProviderIds: string[];
  providerInventoryAuthoritative: boolean;
}

export function buildPersonalShortcutPickerState(providerConfig: unknown, builtinProviderConfig?: unknown): PersonalShortcutPickerState {
  if (!providerConfig || typeof providerConfig !== "object") return { models: [], disabledModelKeys: [], managedProviderIds: [], providerInventoryAuthoritative: false };
  const root = providerConfig as {
    config?: {
      providerConfigRules?: { providerRules?: unknown[] };
      modelConfigRules?: { providerModelRules?: unknown[]; manualProviderModelRules?: unknown[] };
    };
  };
  const rules = root.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(rules)) return { models: [], disabledModelKeys: [], managedProviderIds: [], providerInventoryAuthoritative: false };

  const builtin = builtinProviderConfig && typeof builtinProviderConfig === "object"
    ? builtinProviderConfig as { config?: { modelConfigRules?: { templateModelRules?: unknown[] } } }
    : undefined;
  const templateModelEnabled = new Map<string, boolean>();
  for (const raw of builtin?.config?.modelConfigRules?.templateModelRules ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const modelRule = raw as { templateId?: unknown; modelId?: unknown; config?: { enabled?: unknown } };
    if (typeof modelRule.templateId !== "string" || typeof modelRule.modelId !== "string" || typeof modelRule.config?.enabled !== "boolean") continue;
    templateModelEnabled.set(`${modelRule.templateId}\0${modelRule.modelId}`, modelRule.config.enabled);
  }

  const providerModelEnabled = new Map<string, boolean>();
  for (const raw of [
    ...(root.config?.modelConfigRules?.providerModelRules ?? []),
    ...(root.config?.modelConfigRules?.manualProviderModelRules ?? []),
  ]) {
    if (!raw || typeof raw !== "object") continue;
    const modelRule = raw as { providerId?: unknown; modelId?: unknown; config?: { enabled?: unknown } };
    if (typeof modelRule.providerId !== "string" || typeof modelRule.modelId !== "string" || typeof modelRule.config?.enabled !== "boolean") continue;
    providerModelEnabled.set(`${modelRule.providerId}\0${modelRule.modelId}`, modelRule.config.enabled);
  }

  const apiProviders = mergeDesktopApiProviders({}, providerConfig, builtinProviderConfig);
  const models: PickerModel[] = [];
  const disabledModelKeys = new Set<string>();
  const managedProviderIds = new Set<string>();
  const seen = new Set<string>();
  for (const raw of rules) {
    if (!raw || typeof raw !== "object") continue;
    const rule = raw as {
      providerId?: unknown;
      providerName?: unknown;
      templateId?: unknown;
      enabled?: unknown;
      config?: {
        access?: { type?: unknown; apiKey?: unknown } | null;
        modelOrder?: unknown;
        personalModelIds?: unknown;
        visibility?: unknown;
      };
    };
    const providerId = typeof rule.providerId === "string" ? rule.providerId.trim() : "";
    if (!providerId) continue;
    // This set also prevents stale backend catalog rows from reappearing for
    // account providers. Do not use it to prune configured account models below:
    // OAuth account rows have no per-provider API key, so they are absent from
    // the shortcut model list even when the account catalog is valid.
    managedProviderIds.add(providerId);

    const ids = [
      ...(Array.isArray(rule.config?.modelOrder) ? rule.config.modelOrder : []),
      ...(Array.isArray(rule.config?.personalModelIds) ? rule.config.personalModelIds : []),
    ];
    if (rule.enabled === false || rule.config?.visibility === "hidden") {
      for (const rawModelId of ids) {
        if (typeof rawModelId === "string" && rawModelId.trim()) {
          disabledModelKeys.add(`${providerId}\0${rawModelId.trim()}`);
        }
      }
      continue;
    }
    const hasKey = !!providerApiKey(apiProviders[providerId]);

    for (const rawModelId of ids) {
      if (typeof rawModelId !== "string" || !rawModelId.trim()) continue;
      const modelId = rawModelId.trim();
      const key = `${providerId}\0${modelId}`;
      const providerOverride = providerModelEnabled.get(key);
      const templateDefault = typeof rule.templateId === "string"
        ? templateModelEnabled.get(`${rule.templateId}\0${modelId}`)
        : undefined;
      if ((providerOverride ?? templateDefault) === false) {
        disabledModelKeys.add(key);
        continue;
      }
      if (!hasKey) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      models.push({
        providerId,
        providerName:
          typeof rule.providerName === "string" && rule.providerName.trim()
            ? rule.providerName.trim()
            : providerId,
        kind: "unknown",
        modelId,
        label: modelId,
        hasKey: true,
      });
    }
  }
  return {
    models,
    disabledModelKeys: [...disabledModelKeys],
    managedProviderIds: [...managedProviderIds],
    providerInventoryAuthoritative: true,
  };
}

export function buildPersonalShortcutPicker(providerConfig: unknown, builtinProviderConfig?: unknown): PickerModel[] {
  return buildPersonalShortcutPickerState(providerConfig, builtinProviderConfig).models;
}

export function mergePickerModels(
  configured: readonly PickerModel[],
  shortcuts: readonly PickerModel[]
): PickerModel[] {
  const models = configured.map(model => ({ ...model }));
  const seen = new Set(models.map(model => `${model.providerId}\0${model.modelId}`));
  for (const model of shortcuts) {
    const key = `${model.providerId}\0${model.modelId}`;
    if (seen.has(key)) continue;
    // Keep shortcut-only models beside the provider's configured models. Appending
    // all shortcuts at the end made one provider appear as multiple groups in the
    // picker whenever another provider was configured in between.
    let lastProviderIndex = -1;
    for (let index = 0; index < models.length; index++) {
      if (models[index].providerId === model.providerId) lastProviderIndex = index;
    }
    const insertAt = lastProviderIndex >= 0 ? lastProviderIndex + 1 : models.length;
    models.splice(insertAt, 0, { ...model });
    seen.add(key);
  }
  return models;
}

// Keep the last verified registry during an interrupted desktop config write.
// Scope it to the actual file so isolated profiles never share inventory.
let verifiedShortcutPicker: { file: string; state: PersonalShortcutPickerState } | undefined;

async function readPersonalShortcutPicker(): Promise<PersonalShortcutPickerState> {
  const file = path.join(zcodeDir(), "v2", "provider_config.json");
  const fallback = () => verifiedShortcutPicker?.file === file ? verifiedShortcutPicker.state
    : { models: [], disabledModelKeys: [], managedProviderIds: [], providerInventoryAuthoritative: false };
  if (!fs.existsSync(file)) return fallback();
  try {
    const builtinFile = appServerEnv(resolveBinaryPath()).ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    const [config, builtinConfig] = await Promise.all([
      readDesktopJsonWithRetry<unknown>(file),
      builtinFile && fs.existsSync(builtinFile)
        ? readDesktopJsonWithRetry<unknown>(builtinFile).catch(() => null)
        : Promise.resolve(null),
    ]);
    const state = buildPersonalShortcutPickerState(config, builtinConfig);
    if (!state.providerInventoryAuthoritative) return fallback();
    verifiedShortcutPicker = { file, state };
    return state;
  } catch {
    return fallback();
  }
}

export interface PickerResolution {
  picker: PickerModel[];
  disabledModelKeys: string[];
  managedProviderIds: string[];
  providerInventoryAuthoritative: boolean;
}

export function resolvePickerModels(
  configured: readonly PickerModel[],
  shortcutState: PersonalShortcutPickerState
): PickerResolution {
  const managedProviderIds = new Set(shortcutState.managedProviderIds);
  const enabledShortcutKeys = new Set(shortcutState.models.map(model => `${model.providerId}\0${model.modelId}`));
  const disabledModelKeys = new Set(shortcutState.disabledModelKeys);
  const isAccountOrBuiltin = (providerId: string) => providerId.startsWith("account:") || providerId.startsWith("builtin:");

  // Removing a provider can leave its old config.json row and app-server catalog
  // cached. Once the desktop registry is readable, only its current third-party
  // providers may be shown. Preserve ZCode account and built-in API-key models,
  // which are managed by a separate settings flow.
  const currentConfigured = shortcutState.providerInventoryAuthoritative
    ? configured.filter(model => isAccountOrBuiltin(model.providerId) || managedProviderIds.has(model.providerId))
    : configured;

  // Desktop shortcuts are the live source of truth for their providers. The CLI
  // config can lag behind after a model is removed, so do not resurrect a model
  // from that stale copy (or from the app-server's cached session catalog).
  for (const model of currentConfigured) {
    const key = `${model.providerId}\0${model.modelId}`;
    if (
      managedProviderIds.has(model.providerId) &&
      !model.providerId.startsWith("account:") &&
      !enabledShortcutKeys.has(key)
    ) {
      disabledModelKeys.add(key);
    }
  }

  return {
    picker: mergePickerModels(currentConfigured, shortcutState.models)
      .filter(model => !disabledModelKeys.has(`${model.providerId}\0${model.modelId}`)),
    disabledModelKeys: [...disabledModelKeys],
    managedProviderIds: [...managedProviderIds],
    providerInventoryAuthoritative: shortcutState.providerInventoryAuthoritative,
  };
}

function resolvePicker(config: V2Config | null, shortcutState: PersonalShortcutPickerState): PickerResolution {
  return resolvePickerModels(buildPicker(config), shortcutState);
}

/** Re-read desktop and CLI model metadata without resolving login or restarting the app-server. */
export async function readPickerResolution(): Promise<PickerResolution> {
  const [config, shortcutState] = await Promise.all([
    readRuntimeConfig(),
    readPersonalShortcutPicker(),
  ]);
  return resolvePicker(config, shortcutState);
}

/** Local inventory check only: never refresh credentials or substitute a model. */
export async function isSessionModelAvailable(model: { providerId: string; modelId: string }): Promise<boolean> {
  const resolution = await readPickerResolution();
  const key = `${model.providerId}\0${model.modelId}`;
  if (resolution.disabledModelKeys.includes(key)) return false;
  const managed = resolution.managedProviderIds.includes(model.providerId);
  if (resolution.providerInventoryAuthoritative && !model.providerId.startsWith("account:") && !model.providerId.startsWith("builtin:")) {
    return managed && resolution.picker.some(item => item.providerId === model.providerId && item.modelId === model.modelId && item.hasKey && !item.disabledReason);
  }
  return managed || readV2Config()?.provider?.[model.providerId]?.enabled !== false;
}

export async function resolveRuntime(opts?: {
  appVersion?: string | null;
  modelOverride?: string;
  preferredProviderId?: string;
  preferredModelId?: string;
  /** Existing sessions must never silently resolve an unavailable model to another provider/model. */
  strictPreferredProvider?: boolean;
}): Promise<ResolveResult> {
  const [config, settings, shortcutState] = await Promise.all([
    readRuntimeConfig(),
    readV2SettingsWithRetry(),
    readPersonalShortcutPicker(),
  ]);
  const pickerResolution = resolvePicker(config, shortcutState);
  const { picker } = pickerResolution;
  const disabledModelKeys = new Set(pickerResolution.disabledModelKeys);
  const managedProviderIds = new Set(pickerResolution.managedProviderIds);
  const providers = config?.provider ?? {};
  let exchangedLogin = false;

  const isProviderInDesktopInventory = (providerId: string) =>
    !pickerResolution.providerInventoryAuthoritative ||
    providerId.startsWith("account:") ||
    providerId.startsWith("builtin:") ||
    managedProviderIds.has(providerId);

  const isProviderRuntimeSelectable = (providerId: string) => {
    if (providerId.startsWith("account:")) return true;
    const provider = providers[providerId];
    if (provider?.enabled !== false) return true;
    return pickerResolution.providerInventoryAuthoritative
      && managedProviderIds.has(providerId)
      && picker.some(model => model.providerId === providerId && model.hasKey && !model.disabledReason);
  };

  const isModelSelectable = (providerId: string, modelId: string) => {
    if (!isProviderRuntimeSelectable(providerId)) return false;
    if (disabledModelKeys.has(`${providerId}\0${modelId}`)) return false;
    if (!pickerResolution.providerInventoryAuthoritative || providerId.startsWith("account:") || providerId.startsWith("builtin:")) return true;
    return managedProviderIds.has(providerId) && picker.some(model =>
      model.providerId === providerId && model.modelId === modelId && model.hasKey && !model.disabledReason
    );
  };

  const pickSelectableModelId = (
    providerId: string,
    provider: V2Provider,
    preferredModel?: string
  ): string | null => {
    if (preferredModel) {
      return isModelSelectable(providerId, preferredModel)
        ? pickModelId(provider, preferredModel)
        : null;
    }
    const configuredModelIds = Object.keys(provider.models ?? {});
    const allowedConfiguredModels = configuredModelIds.filter(modelId => isModelSelectable(providerId, modelId));
    if (allowedConfiguredModels.length) {
      const allowedModels = Object.fromEntries(allowedConfiguredModels.map(id => [id, provider.models?.[id]]));
      return pickModelId({ ...provider, models: allowedModels });
    }
    if (configuredModelIds.length) return null;
    if (pickerResolution.providerInventoryAuthoritative && !providerId.startsWith("account:") && !providerId.startsWith("builtin:")) {
      return picker.find(model => model.providerId === providerId && model.hasKey && !model.disabledReason)?.modelId ?? null;
    }
    return "";
  };

  const finish = (
    runtime: ResolvedRuntime,
    warning?: string
  ): ResolveResult => ({
    ok: true,
    runtime,
    picker,
    disabledModelKeys: [...disabledModelKeys],
    managedProviderIds: pickerResolution.managedProviderIds,
    providerInventoryAuthoritative: pickerResolution.providerInventoryAuthoritative,
    warning,
    exchangedLogin,
  });

  const fail = (reason: string, hint: string): ResolveResult => ({
    ok: false,
    reason: t(reason),
    hint: t(hint),
    picker,
    disabledModelKeys: [...disabledModelKeys],
    managedProviderIds: pickerResolution.managedProviderIds,
    providerInventoryAuthoritative: pickerResolution.providerInventoryAuthoritative,
    exchangedLogin,
  });

  const tryStored = (
    providerId: string | null | undefined,
    source: ResolvedRuntime["source"],
    preferredModel?: string
  ): ResolvedRuntime | null => {
    if (!providerId) return null;
    if (usesProjectTokens(opts?.appVersion) && /^(?:account|builtin):/.test(providerId) && isDesktopOauthProvider(providerId) &&
        !providerId.includes("start-plan")) return null;
    if (!isProviderInDesktopInventory(providerId)) return null;
    if (!isProviderRuntimeSelectable(providerId)) return null;
    const provider = providers[providerId];
    if (!provider) return null;
    const key = providerApiKey(provider);
    if (!key) return null;
    const modelId = pickSelectableModelId(providerId, provider, preferredModel);
    if (modelId === null) return null;
    return toRuntime(
      providerId,
      provider,
      modelId,
      key,
      source
    );
  };

  const resolveOauth = async (
    family: PlanFamily,
    kind: PlanKind,
    prefer: OrgProject | undefined,
    providerId: string,
    preferredModel?: string
  ): Promise<ResolvedRuntime | null> => {
    const provider = providers[providerId] ?? fallbackPlanProvider(family, kind);
    const modelId = pickSelectableModelId(providerId, provider, preferredModel);
    if (modelId === null) return null;
    if (!prefer && !(kind !== "start-plan" && usesProjectTokens(opts?.appVersion))) {
      const stored = await readStoredPlanApiKeyWithRetry(`account:${family}-${kind}`);
      if (stored) {
        return toRuntime(
          providerId,
          provider,
          modelId,
          stored,
          "desktop-personal-oauth"
        );
      }
    }
    exchangedLogin = true;
    const oauth = await tryPlanOAuth(family, prefer, kind === "start-plan" ? undefined : opts?.appVersion);
    if (!oauth?.apiKey) return null;
    return {
      ...toRuntime(providerId, provider, modelId, oauth.apiKey,
        prefer ? "desktop-team-oauth" : "desktop-personal-oauth"),
      ...(oauth.apiKeyId ? { apiKeyId: oauth.apiKeyId } : {}),
    };
  };

  const domain = settings?.providerFamilyDomain || "";
  const mode =
    (domain && settings?.modelProviderFamilyModes?.[domain]) || "";
  const selectedKey =
    (domain && settings?.modelProviderFamilySelectedKeys?.[domain]) || "";
  const team = parseTeamPlanKey(selectedKey);
  const plan = readPlanSelection(settings);

  const isOauthCodingPlan = (providerId: string) =>
    isDesktopOauthProvider(providerId) || providerId === team?.providerId;

  // Explicit pick from the UI or a saved new-session default. A model that the
  // desktop has disabled/removed is ignored for new sessions, so the normal
  // desktop default can be used. Existing sessions opt into strict handling.
  const preferredModelUnavailable = !!opts?.preferredProviderId && !!opts.preferredModelId
    && !isModelSelectable(opts.preferredProviderId, opts.preferredModelId);
  const preferredProviderUnavailable = !!opts?.preferredProviderId
    && (!isProviderInDesktopInventory(opts.preferredProviderId) || !isProviderRuntimeSelectable(opts.preferredProviderId));
  if (opts?.strictPreferredProvider && (preferredProviderUnavailable || preferredModelUnavailable)) {
    return fail(
      "Could not reuse ZCode login / default model",
      "Sign in with the ZCode desktop app, or choose a provider that already has an API key."
    );
  }
  if (preferredProviderUnavailable || preferredModelUnavailable) {
    logInfo("Ignoring a desktop-unavailable provider/model saved as the preferred choice", {
      providerId: opts?.preferredProviderId,
      modelId: opts?.preferredModelId,
    });
  }
  if (opts?.preferredProviderId && !preferredProviderUnavailable && !preferredModelUnavailable) {
    const pid = opts.preferredProviderId;
    if (isOauthCodingPlan(pid) && (mode === "oauth" || team)) {
      const target = oauthTarget(pid, plan, team);
      if (!target) {
        return fail(
          "Could not refresh the team plan login",
          "Open the ZCode desktop app, make sure the team plan is selected, then Retry."
        );
      }
      const picked = await resolveOauth(
        target.family,
        target.kind,
        target.team,
        target.providerId,
        opts.preferredModelId
      );
      if (picked) {
        logInfo("Using OAuth coding/team plan selected in VS Code", {
          providerId: picked.providerId,
          team: !!team,
        });
        return finish(picked);
      }
      return fail(
        "Could not refresh the BigModel team / coding-plan login",
        "Open the ZCode desktop app, make sure the team plan is selected, then Retry."
      );
    }
    const stored = tryStored(pid, "vscode-override", opts.preferredModelId);
    if (stored) {
      logInfo("Using stored provider selected in VS Code", pid);
      return finish(stored);
    }
    return fail(
      t("提供商 {0} 没有可用的 API 密钥", { 0: pid }),
      "Log in via the ZCode desktop app, or pick another provider."
    );
  }

  // VS Code setting zcode.model
  const override = parseModelOverride(opts?.modelOverride ?? "");
  if (override) {
    if (isOauthCodingPlan(override.providerId)) {
      const target = oauthTarget(override.providerId, plan, team);
      const picked = target
        ? await resolveOauth(
            target.family,
            target.kind,
            target.team,
            target.providerId,
            override.modelId
          )
        : null;
      if (picked) return finish(picked);
    }
    const stored = tryStored(
      override.providerId,
      "vscode-override",
      override.modelId
    );
    if (stored) return finish(stored);
  }

  // Desktop family: oauth (personal or team) vs apiKey vs custom
  if (domain === "bigmodel" || domain === "zai") {
    if (mode === "apiKey") {
      const stored = tryStored(`builtin:${domain}`, "desktop-apikey");
      if (stored) {
        logInfo("Reusing desktop API-key mode", stored.providerId);
        return finish(stored);
      }
      logWarn("Desktop is in API-key mode but no key is saved");
    } else if (plan) {
      const picked = await resolveOauth(
        plan.family,
        plan.kind,
        plan.team,
        plan.providerId
      );
      if (picked) {
        logInfo("Reusing ZCode desktop OAuth selection", {
          domain,
          kind: plan.kind,
          organizationId: plan.team?.organizationId,
          projectId: plan.team?.projectId,
          providerId: picked.providerId,
          modelId: picked.modelId,
        });
        return finish(picked);
      }
      return fail(
        plan.kind === "team-coding-plan"
          ? "Could not reuse the team plan"
          : "Could not reuse the desktop plan login",
        "Open the ZCode desktop app, stay signed in with the same account or team, then Retry. You can also switch to a custom provider from the model chip."
      );
    }
  }

  // Enabled custom / third-party providers
  for (const [pid, provider] of Object.entries(providers)) {
    if (pid.startsWith("builtin:")) continue;
    if (!isProviderRuntimeSelectable(pid)) continue;
    const stored = tryStored(pid, "custom-provider");
    if (stored) {
      logInfo("Using enabled custom provider", pid);
      return finish(stored);
    }
  }

  if (!fs.existsSync(path.join(zcodeDir(), "v2"))) {
    return fail(
      "ZCode desktop data not found",
      "Install and sign in to the ZCode desktop app, then reopen this view — or pick a provider if you already have an API key."
    );
  }

  return fail(
    "Could not reuse ZCode login / default model",
    "Sign in with the ZCode desktop app, or choose a provider that already has an API key."
  );
}

/**
 * Credentials for an existing session: keep that session's model, but use the
 * current desktop login for the same provider (team/personal/custom).
 * Never reuse a cached coding-plan key from config.json.
 */
export async function resolveRuntimeForSession(model: {
  providerId: string;
  modelId: string;
}, appVersion?: string | null): Promise<ResolvedRuntime | null | false> {
  const resolved = await resolveRuntime({
    preferredProviderId: model.providerId,
    preferredModelId: model.modelId,
    strictPreferredProvider: true,
    appVersion,
  });
  const isAccountOrBuiltin = model.providerId.startsWith("account:") || model.providerId.startsWith("builtin:");
  const configuredProvider = readV2Config()?.provider?.[model.providerId];
  const providerDisabled = configuredProvider?.enabled === false
    && (!resolved.providerInventoryAuthoritative || !resolved.managedProviderIds?.includes(model.providerId));
  const modelUnavailable = resolved.disabledModelKeys?.includes(`${model.providerId}\0${model.modelId}`)
    || providerDisabled
    || (resolved.providerInventoryAuthoritative && !isAccountOrBuiltin && (
      !resolved.managedProviderIds?.includes(model.providerId)
      || !resolved.picker.some(item => item.providerId === model.providerId && item.modelId === model.modelId && item.hasKey && !item.disabledReason)
    ));
  // `false` means the desktop registry explicitly removed or disabled this
  // model. Callers must not revive it from the stale CLI provider cache.
  if (modelUnavailable) return false;
  if (resolved.runtime) {
    return { ...resolved.runtime, modelId: model.modelId };
  }
  if (
    resolved.providerInventoryAuthoritative &&
    !model.providerId.startsWith("account:") &&
    !model.providerId.startsWith("builtin:") &&
    !resolved.managedProviderIds?.includes(model.providerId)
  ) return null;
  if (resolved.providerInventoryAuthoritative && resolved.managedProviderIds?.includes(model.providerId)) return null;
  if (isDesktopOauthProvider(model.providerId)) return null;
  return runtimeFromStoredProvider(model.providerId, model.modelId);
}

export function syncCliConfig(
  runtime: ResolvedRuntime,
  all?: V2Config | null,
  updateDefaultModel = true
): string {
  const dir = cliDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  const configPath = path.join(dir, "config.json");

  let existing: {
    model?: string;
    provider?: Record<string, unknown>;
  } = {};
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      existing = {};
    }
  }

  const providerMap: Record<string, unknown> = {
    ...(existing.provider ?? {}),
  };

  // Once the desktop shortcut registry is readable, it is the authority for
  // third-party providers. Do not copy deleted providers back from stale CLI
  // or desktop config into the app-server's next session defaults.
  let shortcutInventory: PersonalShortcutPickerState | null = null;
  let shortcutConfig: unknown;
  let builtinConfig: unknown;
  const shortcutFile = path.join(zcodeDir(), "v2", "provider_config.json");
  if (fs.existsSync(shortcutFile)) {
    try {
      shortcutConfig = readDesktopJson<unknown>(shortcutFile);
      const builtinFile = appServerEnv(resolveBinaryPath()).ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
      builtinConfig = builtinFile && fs.existsSync(builtinFile)
        ? readDesktopJson<unknown>(builtinFile)
        : undefined;
      shortcutInventory = buildPersonalShortcutPickerState(shortcutConfig, builtinConfig);
    } catch {
      // A partial desktop write must not be interpreted as an empty inventory.
    }
  }
  const inventoryIsAuthoritative = shortcutInventory?.providerInventoryAuthoritative === true;
  const managedProviderIds = new Set(shortcutInventory?.managedProviderIds ?? []);
  const providerIsCurrent = (providerId: string) =>
    !inventoryIsAuthoritative || providerId.startsWith("account:") || providerId.startsWith("builtin:") || managedProviderIds.has(providerId);
  if (inventoryIsAuthoritative) {
    for (const providerId of Object.keys(providerMap)) {
      if (!providerIsCurrent(providerId)) delete providerMap[providerId];
    }
    const defaultRef = typeof existing.model === "string" ? existing.model : "";
    const slash = defaultRef.indexOf("/");
    const defaultProviderId = slash > 0 ? defaultRef.slice(0, slash) : "";
    const defaultModelId = slash > 0 ? defaultRef.slice(slash + 1) : "";
    const defaultModelAvailable = defaultProviderId.startsWith("account:") || defaultProviderId.startsWith("builtin:")
      || shortcutInventory?.models.some(model => model.providerId === defaultProviderId && model.modelId === defaultModelId);
    if (defaultProviderId && (!providerIsCurrent(defaultProviderId) || !defaultModelAvailable)) delete existing.model;
  }

  // Project tokens belong to the request-time auth channel, never CLI config.
  if (runtime.apiKeyId) delete providerMap[runtime.providerId];
  const v2Providers = mergeDesktopApiProviders(all?.provider ?? readV2Config()?.provider ?? {}, shortcutConfig, builtinConfig);
  for (const [pid, p] of Object.entries(v2Providers)) {
    if (!providerIsCurrent(pid)) continue;
    const key = pid === runtime.providerId ? (runtime.apiKeyId ? "" : runtime.apiKey) : providerApiKey(p);
    if (!key) {
      if (managedProviderIds.has(pid)) delete providerMap[pid];
      continue;
    }
    providerMap[pid] = {
      name: p.name ?? pid,
      kind: p.kind ?? "openai-compatible",
      options: {
        apiKey: key,
        baseURL: p.options?.baseURL ?? "",
      },
      models: p.models ?? {},
    };
  }

  if (!runtime.providerId.startsWith("account:") && providerIsCurrent(runtime.providerId)) {
    providerMap[runtime.providerId] = {
      name: runtime.providerName,
      kind: runtime.kind,
      options: {
        ...(runtime.apiKeyId ? {} : { apiKey: runtime.apiKey }),
        baseURL: runtime.baseURL,
      },
      models: runtime.models,
    };
  }

  const cliConfig = {
    ...existing,
    provider: providerMap,
  };

  // Config is consumed by the desktop CLI. Protect both existing keys and new writes.
  if (fs.existsSync(configPath) && process.platform !== "win32") {
    fs.chmodSync(configPath, 0o600);
  }
  const temporary = path.join(dir, `.config-${crypto.randomBytes(12).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(cliConfig, null, 2), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, configPath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  logInfo("Synced CLI config from desktop defaults", {
    path: configPath,
    model: cliConfig.model,
    source: runtime.source,
    updateDefaultModel,
  });
  return configPath;
}

export function runtimeEnv(runtime: ResolvedRuntime): Record<string, string> {
  const env: Record<string, string> = {};
  if (runtime.kind === "anthropic" && runtime.apiKey && !runtime.apiKeyId) {
    env.ANTHROPIC_API_KEY = runtime.apiKey;
  }
  return env;
}

export function runtimeFromStoredProvider(
  providerId: string,
  modelId?: string
): ResolvedRuntime | null {
  const config = readV2Config();
  const provider = config?.provider?.[providerId];
  if (!provider) return null;
  const key = providerApiKey(provider);
  if (!key) return null;
  return toRuntime(
    providerId,
    provider,
    pickModelId(provider, modelId),
    key,
    providerId.startsWith("builtin:") ? "desktop-apikey" : "custom-provider"
  );
}
