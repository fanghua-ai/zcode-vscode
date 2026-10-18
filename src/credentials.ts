import * as crypto from "crypto";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { readJsonRequest } from "./httpJson";
import { logDebug, logInfo, logWarn } from "./log";
import { readDesktopJson, readDesktopJsonWithRetry } from "./desktopJson";

/**
 * Decrypt ~/.zcode/v2/credentials.json and exchange BigModel OAuth tokens.
 * Desktop selection / CLI sync lives in desktop.ts.
 */

const ENC_PREFIX = "enc:v1:";
const CIPHER = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const CREDENTIAL_SECRET_ENV = "ZCODE_CREDENTIAL_SECRET";

export const CRED_KEYS = {
  activeProvider: "oauth:active_provider",
  bigmodelAccessToken: "oauth:bigmodel:access_token",
  bigmodelUserInfo: "oauth:bigmodel:user_info",
  zaiAccessToken: "oauth:zai:access_token",
  zcodeJwtToken: "zcodejwttoken",
} as const;

export type PlanFamily = "bigmodel" | "zai";

const PLAN_HOST: Record<PlanFamily, string> = {
  bigmodel: "https://bigmodel.cn",
  zai: "https://api.z.ai",
};
const ZCODE_API_KEY_NAME = "zcode-api-key";
const ZCODE_TEAM_API_KEY_NAME = "zcode-team-api-key";
const TEAM_PLAN_KEY_TYPE = 2;

export interface V2Provider {
  name?: string;
  kind?: string;
  enabled?: boolean;
  source?: string;
  options?: {
    apiKey?: string;
    baseURL?: string;
    apiKeyRequired?: boolean;
  };
  models?: Record<string, unknown>;
}

export interface V2Config {
  model?: string;
  provider?: Record<string, V2Provider>;
}

export interface V2Settings {
  recentProjects?: string[];
  providerFamilyDomain?: string;
  modelProviderFamilyModes?: Record<string, string>;
  modelProviderFamilySelectedKeys?: Record<string, string>;
  providerFamilyConnectionSelections?: Record<
    string,
    { kind?: string; productId?: string; organizationId?: string; projectId?: string }
  >;
  enabledBuiltinAgentCliProviders?: string[];
}

export interface ConfiguredProviderApiKey {
  apiKey: string;
  baseURL?: string;
}

/**
 * Reuse the credential ZCode already selected for this exact provider. This is
 * intentionally host-only data for the quota adapter; never send it to a
 * webview or include it in logs.
 */
export async function readConfiguredProviderApiKey(providerId: string, templateId?: string): Promise<ConfiguredProviderApiKey | null> {
  const shortcut = await readShortcutProviderApiKey(providerId, templateId);
  if (shortcut) return shortcut;

  const v2Provider = (await readV2ConfigWithRetry())?.provider?.[providerId];
  const fromV2 = providerApiKeyAndBase(v2Provider?.options?.apiKey, v2Provider?.options?.baseURL);
  if (fromV2) return fromV2;

  try {
    const root = await readDesktopJsonWithRetry<unknown>(path.join(cliDir(), "config.json"));
    const providers = recordAt(root, "provider");
    const provider = providers?.[providerId];
    const options = recordAt(provider, "options");
    return providerApiKeyAndBase(options?.apiKey, options?.baseURL);
  } catch {
    return null;
  }
}

async function readShortcutProviderApiKey(providerId: string, templateId?: string): Promise<ConfiguredProviderApiKey | null> {
  try {
    const root = await readDesktopJsonWithRetry<unknown>(path.join(v2Dir(), "provider_config.json"));
    const config = recordAt(root, "config");
    const rulesContainer = recordAt(config, "providerConfigRules");
    const rules = rulesContainer?.providerRules;
    if (!Array.isArray(rules)) return null;
    const matches = rules.filter((raw) => {
      const rule = recordAt(raw, "");
      return rule?.providerId === providerId && (templateId === undefined || rule.templateId === templateId);
    });
    // Ambiguous duplicate rules must never decide which account key is used.
    if (matches.length !== 1) return null;
    const rule = recordAt(matches[0], "");
    const ruleConfig = recordAt(rule, "config");
    const access = recordAt(ruleConfig, "access");
    const api = recordAt(ruleConfig, "api");
    if (access?.type !== "api-key") return null;
    return providerApiKeyAndBase(access.apiKey, api?.baseUrl);
  } catch {
    return null;
  }
}

function providerApiKeyAndBase(rawKey: unknown, rawBaseURL: unknown): ConfiguredProviderApiKey | null {
  if (typeof rawKey !== "string") return null;
  const apiKey = maybeDecryptSecret(rawKey).trim();
  const baseURL = typeof rawBaseURL === "string" ? rawBaseURL.trim() : "";
  return apiKey ? { apiKey, ...(baseURL ? { baseURL } : {}) } : null;
}

function recordAt(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (key === "") return record;
  const child = record[key];
  return child && typeof child === "object" && !Array.isArray(child) ? child as Record<string, unknown> : null;
}

function resolveCredentialSecret(env: NodeJS.ProcessEnv): string {
  const explicit = env[CREDENTIAL_SECRET_ENV]?.trim();
  if (explicit) return explicit;

  let username = "unknown";
  try {
    username = os.userInfo().username;
  } catch {
    // keep "unknown"
  }
  return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${username}`;
}

function deriveCipherKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret).digest();
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

export function decryptValue(value: string, key: Buffer): string {
  if (!isEncrypted(value)) return value;

  const payload = value.slice(ENC_PREFIX.length);
  const parts = payload.split(".");
  if (parts.length !== 3) {
    throw new Error("Credential decrypt failed: invalid ciphertext format");
  }

  const [ivB64, authTagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64url");
  const authTag = Buffer.from(authTagB64, "base64url");
  const data = Buffer.from(dataB64, "base64url");

  if (iv.length !== IV_LENGTH) {
    throw new Error("Credential decrypt failed: invalid IV length");
  }
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error("Credential decrypt failed: invalid auth tag length");
  }

  const decipher = crypto.createDecipheriv(CIPHER, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString();
}

export function zcodeDir(): string {
  return path.join(os.homedir(), ".zcode");
}

export function v2Dir(): string {
  return path.join(zcodeDir(), "v2");
}

export function cliDir(): string {
  return path.join(zcodeDir(), "cli");
}

export function readV2Config(): V2Config | null {
  const p = path.join(v2Dir(), "config.json");
  if (!fs.existsSync(p)) return null;
  try {
    return readDesktopJson<V2Config>(p);
  } catch {
    return null;
  }
}

export function readV2Settings(): V2Settings | null {
  const p = path.join(v2Dir(), "setting.json");
  if (!fs.existsSync(p)) return null;
  try {
    return readDesktopJson<V2Settings>(p);
  } catch {
    return null;
  }
}

export async function readV2ConfigWithRetry(): Promise<V2Config | null> {
  try { return await readDesktopJsonWithRetry<V2Config>(path.join(v2Dir(), "config.json")); } catch { return null; }
}

export async function readV2SettingsWithRetry(): Promise<V2Settings | null> {
  try { return await readDesktopJsonWithRetry<V2Settings>(path.join(v2Dir(), "setting.json")); } catch { return null; }
}

export async function readCredentialsWithRetry(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
  const raw = await readDesktopJsonWithRetry<Record<string, string>>(path.join(v2Dir(), "credentials.json"));
  return decryptCredentials(raw, env);
}

export function readCredentials(
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const credPath = path.join(v2Dir(), "credentials.json");
  if (!fs.existsSync(credPath)) {
    throw new Error(
      "ZCode credentials not found. Please log in via the ZCode desktop app first."
    );
  }

  return decryptCredentials(readDesktopJson<Record<string, string>>(credPath), env);
}

function decryptCredentials(raw: Record<string, string>, env: NodeJS.ProcessEnv): Record<string, string> {
  const key = deriveCipherKey(resolveCredentialSecret(env));

  const result: Record<string, string> = {};
  let failed = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && isEncrypted(v)) {
      try {
        result[k] = decryptValue(v, key);
      } catch {
        failed++; // Do not reuse values encrypted for another user or secret.
      }
    } else if (typeof v === "string") {
      result[k] = v;
    }
  }
  if (failed) logWarn("Desktop credential decryption failed", { failedValues: failed });
  return result;
}

export function maybeDecryptSecret(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (!value) return "";
  if (!isEncrypted(value)) return value;
  try {
    const key = deriveCipherKey(resolveCredentialSecret(env));
    return decryptValue(value, key);
  } catch {
    return "";
  }
}

async function httpGetJson(url: string, headers: Record<string, string>): Promise<{ code: number; msg?: string; data: unknown }> {
  try { return await httpGetJsonOnce(url, headers); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH"].includes(code ?? "")) throw error;
    logDebug("Retrying desktop login read request", { code });
    await new Promise(resolve => setTimeout(resolve, 200));
    return httpGetJsonOnce(url, headers);
  }
}

function httpGetJsonOnce(
  url: string,
  headers: Record<string, string>
): Promise<{ code: number; msg?: string; data: unknown }> {
  return readJsonRequest(receive => https.get(url, { headers }, receive)) as Promise<{ code: number; msg?: string; data: unknown }>;
}

function httpPostJson(
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<{ code: number; msg?: string; data: unknown }> {
  const postData = JSON.stringify(body);
  const target = new URL(url);
  return readJsonRequest(receive => {
    const req = https.request({
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
    }, receive);
    req.write(postData);
    req.end();
    return req;
  }) as Promise<{ code: number; msg?: string; data: unknown }>;
}

interface Organization {
  organizationId: string;
  organizationName?: string;
  projects: Project[];
}

interface Project {
  projectId: string;
  projectName?: string;
}

interface ApiKey {
  name: string;
  apiKey: string;
  keyType?: number;
}

export interface OrgProject {
  organizationId: string;
  projectId: string;
}

function isMarkedCurrent(row: object): boolean {
  const record = row as Record<string, unknown>;
  return ["isDefault", "default", "current", "selected", "isCurrent"].some(
    (key) => record[key] === true
  );
}

/**
 * Org/project for a personal or start plan. Team plans pass `prefer` and never
 * reach the list. Display names are not used: a localized name is not an id.
 * One organization and one project is unambiguous. A single current/default
 * flag is unambiguous. Anything else must be chosen in the desktop app.
 */
export function pickOrgAndProject(
  data: unknown,
  prefer?: OrgProject
): OrgProject | null {
  if (prefer?.organizationId && prefer.projectId) {
    return {
      organizationId: prefer.organizationId,
      projectId: prefer.projectId,
    };
  }

  const orgs = (
    (data as { organizations?: Organization[] })?.organizations ?? []
  ).filter(
    (org) =>
      !!org?.organizationId && (org.projects ?? []).some((p) => p?.projectId)
  );
  const flaggedOrgs = orgs.filter((org) => isMarkedCurrent(org));
  const pool =
    flaggedOrgs.length === 1 ? flaggedOrgs : orgs.length === 1 ? orgs : [];
  const org = pool[0];
  if (!org?.organizationId) return null;

  const projects = (org.projects ?? []).filter((p) => p?.projectId);
  const flaggedProjects = projects.filter((p) => isMarkedCurrent(p));
  const proj =
    flaggedProjects.length === 1
      ? flaggedProjects[0]
      : projects.length === 1
        ? projects[0]
        : null;
  if (!proj?.projectId) return null;
  return { organizationId: org.organizationId, projectId: proj.projectId };
}

async function withCopiedSecret(
  keysUrl: string,
  headers: Record<string, string>,
  apiKey: string,
  requireSecret: boolean
): Promise<string> {
  try {
    const copyResp = await httpGetJson(
      `${keysUrl}/copy/${encodeURIComponent(apiKey)}`,
      headers
    );
    if (copyResp.code === 200) {
      const secret = (copyResp.data as { secretKey?: string } | undefined)
        ?.secretKey?.trim();
      if (secret) return `${apiKey}.${secret}`;
    }
  } catch {
    // Desktop does this extra copy step; raw key still works for some plans.
  }
  if (requireSecret) {
    throw new Error("API key copy response is missing secretKey");
  }
  return apiKey;
}

function bizOk(resp: { code: number; msg?: string; data: unknown }): boolean {
  if (typeof resp.code === "number") return resp.code === 0 || resp.code === 200;
  return resp.data !== undefined;
}

function bizHeaders(accessToken: string, team?: OrgProject): Record<string, string> {
  const headers: Record<string, string> = { Authorization: accessToken };
  if (team) {
    headers["bigmodel-organization"] = team.organizationId;
    headers["bigmodel-project"] = team.projectId;
  }
  return headers;
}

function isUsableTeamPlanKey(key: ApiKey | undefined): key is ApiKey {
  return (
    !!key?.apiKey?.trim() &&
    key.name === ZCODE_TEAM_API_KEY_NAME &&
    key.keyType === TEAM_PLAN_KEY_TYPE
  );
}

export async function resolveApiKey(
  family: PlanFamily,
  authorization: string,
  prefer?: OrgProject
): Promise<string> {
  const host = PLAN_HOST[family];
  const requireSecret = family === "zai";
  const headers = bizHeaders(authorization, prefer);

  let orgProj: OrgProject | null = prefer ?? null;
  if (!orgProj) {
    const infoResp = await httpGetJson(
      `${host}/api/biz/customer/getCustomerInfo`,
      { Authorization: authorization }
    );
    if (infoResp.code !== 200) {
      throw new Error(
        `Failed to get customer info: ${infoResp.msg ?? infoResp.code}`
      );
    }
    orgProj = pickOrgAndProject(infoResp.data);
  }
  if (!orgProj) {
    throw new Error(
      "Desktop selection has no organization, and the account has more than one organization or project"
    );
  }

  const keysUrl = `${host}/api/biz/v1/organization/${encodeURIComponent(
    orgProj.organizationId
  )}/projects/${encodeURIComponent(orgProj.projectId)}/api_keys`;
  const keysResp = await httpGetJson(keysUrl, headers);
  if (!bizOk(keysResp)) {
    throw new Error(
      `Failed to list API keys: ${keysResp.msg ?? keysResp.code}`
    );
  }

  const keys = (keysResp.data as ApiKey[]) ?? [];

  if (prefer) {
    const existing = keys.find(isUsableTeamPlanKey);
    if (existing) {
      logInfo("Using BigModel team-plan API key", {
        organizationId: orgProj.organizationId,
        projectId: orgProj.projectId,
        keyType: existing.keyType,
      });
      return withCopiedSecret(keysUrl, headers, existing.apiKey.trim(), requireSecret);
    }

    const createResp = await httpPostJson(keysUrl, headers, {
      name: ZCODE_TEAM_API_KEY_NAME,
      keyType: TEAM_PLAN_KEY_TYPE,
    });
    if (!bizOk(createResp)) {
      throw new Error(
        `Failed to create team API key: ${createResp.msg ?? createResp.code}`
      );
    }
    const created = createResp.data as ApiKey | undefined;
    if (!isUsableTeamPlanKey(created)) {
      throw new Error(
        "Team API key creation did not return a usable team-plan key"
      );
    }
    logInfo("Created BigModel team-plan API key", {
      organizationId: orgProj.organizationId,
      projectId: orgProj.projectId,
    });
    return withCopiedSecret(keysUrl, headers, created.apiKey.trim(), requireSecret);
  }

  const personal =
    keys.find((k) => k.name === ZCODE_API_KEY_NAME && k.apiKey) ??
    keys.find((k) => k.name !== ZCODE_TEAM_API_KEY_NAME && k.apiKey);
  if (personal?.apiKey) {
    logInfo("Using personal plan API key", { name: personal.name, family });
    return withCopiedSecret(keysUrl, headers, personal.apiKey.trim(), requireSecret);
  }

  const createResp = await httpPostJson(keysUrl, headers, {
    name: ZCODE_API_KEY_NAME,
  });
  if (!bizOk(createResp)) {
    throw new Error(
      `Failed to create API key: ${createResp.msg ?? createResp.code}`
    );
  }

  const newKey = createResp.data as ApiKey | undefined;
  if (!newKey?.apiKey) {
    throw new Error("API key creation returned empty key");
  }
  return withCopiedSecret(keysUrl, headers, newKey.apiKey.trim(), requireSecret);
}

async function resolveZaiBizToken(accessToken: string): Promise<string> {
  const resp = await httpPostJson(
    `${PLAN_HOST.zai}/api/auth/z/login`,
    {},
    { token: accessToken }
  );
  if (!bizOk(resp)) {
    throw new Error(`Failed to exchange Z.AI biz token: ${resp.msg ?? resp.code}`);
  }
  const data = resp.data as { access_token?: string; accessToken?: string } | undefined;
  const token = data?.access_token?.trim() || data?.accessToken?.trim() || "";
  if (!token) throw new Error("Z.AI biz token response is missing access_token");
  return token;
}

/** Desktop-stored key for one account plan. Multiple stored accounts are not guessed. */
export function readStoredPlanApiKey(accountProviderId: string, loaded?: Record<string, string>): string | null {
  let creds: Record<string, string>;
  try {
    creds = loaded ?? readCredentials();
  } catch {
    return null;
  }
  const prefix = `account-provider:coding-plan:${accountProviderId}:account:`;
  const matches = Object.entries(creds).filter(
    ([key, value]) => key.startsWith(prefix) && key.endsWith(":api-key") && value.trim()
  );
  if (matches.length !== 1) return null;
  return matches[0][1].trim();
}

export async function readStoredPlanApiKeyWithRetry(accountProviderId: string): Promise<string | null> {
  try { return readStoredPlanApiKey(accountProviderId, await readCredentialsWithRetry()); } catch { return null; }
}

export async function tryPlanOAuth(
  family: PlanFamily,
  prefer?: OrgProject
): Promise<{
  apiKey: string;
  activeProvider: string | null;
} | null> {
  let stage = "read_credentials";
  try {
    const creds = await readCredentialsWithRetry();
    const activeProvider = creds[CRED_KEYS.activeProvider] ?? null;
    const accessToken =
      creds[family === "zai" ? CRED_KEYS.zaiAccessToken : CRED_KEYS.bigmodelAccessToken] ??
      null;
    if (!accessToken) {
      logWarn("Desktop OAuth token is unavailable", { family });
      return null;
    }
    stage = "exchange_api_key";
    const authorization =
      family === "zai" ? `Bearer ${await resolveZaiBizToken(accessToken)}` : accessToken;
    const apiKey = await resolveApiKey(family, authorization, prefer);
    return { apiKey, activeProvider: activeProvider ?? family };
  } catch (e) {
    logWarn("Plan API key exchange failed", { family, team: !!prefer, stage, code: (e as NodeJS.ErrnoException).code ?? (e as Error).name, status: /\b(?:401|403|429|5\d\d)\b/.exec((e as Error).message ?? "")?.[0] });
    return null;
  }
}

export interface QuotaLine {
  label: string;
  /** 0–100, share of the pool still unused, when the provider exposes a limit. */
  remainingPercent?: number;
  /** 0–100, share already used, when the provider exposes a limit. */
  usedPercent?: number;
  remainingCount?: number;
  nextResetTime?: number;
  /** Monetary balances have no percentage unless a budget ceiling is also known. */
  remainingAmount?: number;
  currency?: string;
  grantedAmount?: number;
  toppedUpAmount?: number;
  /** Provider-defined numeric readings such as today's spend, shown without inventing a quota percentage. */
  metrics?: QuotaMetric[];
}

export interface QuotaMetric {
  label: string;
  value: number;
  format: "number" | "currency";
  currency?: string;
  unit?: string;
  period?: string;
}

export interface PlanQuotaLimit extends QuotaLine {
  remainingPercent: number;
  usedPercent: number;
}

export async function fetchPlanQuota(plan: {
  family: PlanFamily;
  kind: "individual-coding-plan" | "team-coding-plan" | "start-plan";
  team?: OrgProject;
}, appVersion?: string | null): Promise<PlanQuotaLimit[]> {
  if (plan.kind === "start-plan") {
    return fetchStartPlanQuota(appVersion);
  }

  // Team plans exchange a key with the desktop's org and project.
  // Personal Coding Plans use the desktop-stored account key when there is
  // exactly one, so a multi-org account is not assigned by display name.
  let apiKey = "";
  if (!plan.team) {
    apiKey = readStoredPlanApiKey(`account:${plan.family}-${plan.kind}`) ?? "";
  }
  if (!apiKey) {
    apiKey = (await tryPlanOAuth(plan.family, plan.team))?.apiKey?.trim() ?? "";
  }
  if (!apiKey) return [];
  const host = PLAN_HOST[plan.family];
  const url = plan.team
    ? `${host}/api/monitor/usage/quota/limit?type=2`
    : `${host}/api/monitor/usage/quota/limit`;
  const resp = await httpGetJson(url, bizHeaders(apiKey, plan.team));
  if (!bizOk(resp)) {
    throw new Error(`Failed to read plan quota: ${resp.msg ?? resp.code}`);
  }
  const data = resp.data as { limits?: unknown } | undefined;
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  return limits
    .map(readPlanLimit)
    .filter((row): row is PlanQuotaLimit => row !== null);
}

interface StartPlanBalanceResponse {
  code?: number;
  msg?: string;
  data?: {
    server_time?: number;
    plans?: Array<{
      user_plan_id?: string;
      plan_id?: string;
      name?: string;
      status?: string;
      starts_at?: number | string | null;
      ends_at?: number | string | null;
    }>;
    balances?: Array<{
      user_plan_id?: string;
      plan_id?: string;
      show_name?: string;
      meter?: string;
      total_units?: number | string | null;
      remaining_units?: number | string | null;
      expires_at?: number | string | null;
    }>;
  };
}

const START_PLAN_BALANCE_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance";

async function fetchStartPlanQuota(appVersion?: string | null): Promise<PlanQuotaLimit[]> {
  let credentials: Record<string, string>;
  try {
    credentials = await readCredentialsWithRetry();
  } catch {
    return [];
  }
  const jwt = credentials[CRED_KEYS.zcodeJwtToken]?.trim();
  if (!jwt) return [];

  const url = new URL(START_PLAN_BALANCE_URL);
  // The desktop app version affects which Start Plan entitlements the service
  // returns. Never substitute the extension version for the desktop version.
  if (appVersion && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(appVersion)) {
    url.searchParams.set("app_version", appVersion);
  }
  const response = await httpGetJson(url.toString(), { Authorization: `Bearer ${jwt}` }) as StartPlanBalanceResponse;
  if (response.code !== 0) {
    throw new Error(`Failed to read Start Plan balance: ${response.msg ?? response.code ?? "invalid response"}`);
  }

  const plans = Array.isArray(response.data?.plans) ? response.data.plans : [];
  const now = finiteNonNegative(response.data?.server_time) ?? Date.now() / 1000;
  const activePlans = plans.filter((plan) => {
    const status = plan.status?.trim().toLowerCase();
    const id = plan.plan_id?.trim().toLowerCase() ?? "";
    const name = plan.name?.trim().toLowerCase() ?? "";
    const start = finitePositive(plan.starts_at);
    const end = finitePositive(plan.ends_at);
    return status === "active" &&
      (id.includes("start-plan") || id.includes("start plan") || name.includes("start-plan") || name.includes("start plan")) &&
      (start === null || start <= now) &&
      (end === null || end > now);
  });
  if (activePlans.length === 0) return [];

  const balances = Array.isArray(response.data?.balances) ? response.data.balances : [];
  const ownedBalances = balances.filter((balance) => activePlans.some((plan) =>
    balance.user_plan_id && plan.user_plan_id
      ? balance.user_plan_id === plan.user_plan_id
      : !!balance.plan_id && balance.plan_id === plan.plan_id,
  ));
  if (ownedBalances.length !== balances.length) {
    logWarn("Start Plan balance contains buckets without an active plan", {
      ignoredBucketCount: balances.length - ownedBalances.length,
    });
  }

  return ownedBalances
    .map((balance): PlanQuotaLimit | null => {
      const total = finiteNonNegative(balance.total_units);
      // `available_units` subtracts in-flight reservations; the desktop quota
      // display uses the server's remaining_units instead.
      const remaining = finiteNonNegative(balance.remaining_units);
      if (total === null || total <= 0 || remaining === null) return null;
      const remainingPercent = Math.max(0, Math.min(100, (remaining / total) * 100));
      const resetSeconds = finitePositive(balance.expires_at);
      const label = balance.show_name?.trim() || balance.meter?.trim() || "体验额度";
      return {
        label,
        remainingPercent,
        usedPercent: 100 - remainingPercent,
        remainingCount: remaining,
        ...(resetSeconds !== null ? { nextResetTime: resetSeconds * 1000 } : {}),
      };
    })
    .filter((row): row is PlanQuotaLimit => row !== null);
}

function finiteNonNegative(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function finitePositive(value: unknown): number | null {
  const parsed = finiteNonNegative(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function readPlanLimit(raw: unknown): PlanQuotaLimit | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as {
    type?: string;
    unit?: number;
    number?: number;
    percentage?: number;
    remaining?: number;
    nextResetTime?: number;
  };
  if (typeof row.percentage !== "number" || !Number.isFinite(row.percentage)) {
    return null;
  }
  const usedPercent = Math.max(0, Math.min(100, row.percentage));
  const remainingPercent = Math.max(0, Math.min(100, 100 - usedPercent));
  const label = planLimitLabel(row.type, row.unit, row.number);
  if (!label) return null;
  return {
    label,
    usedPercent,
    remainingPercent,
    ...(typeof row.remaining === "number" ? { remainingCount: row.remaining } : {}),
    ...(typeof row.nextResetTime === "number" ? { nextResetTime: row.nextResetTime } : {}),
  };
}

function planLimitLabel(
  type: string | undefined,
  unit: number | undefined,
  number: number | undefined
): string | null {
  // Known windows keep the desktop labels. Any other limit still shows,
  // using the server's own type name instead of being dropped.
  const tokenLike = type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT";
  if (tokenLike && unit === 3 && number === 5) return "5 小时";
  if (tokenLike && unit === 6) return "每周";
  if (type === "TIME_LIMIT" && unit === 5 && number === 1) return "工具调用";
  return type || null;
}

export function hasPlanOAuthToken(family: PlanFamily, creds?: Record<string, string> | null): boolean {
  let loaded = creds;
  if (loaded === undefined) {
    try {
      loaded = readCredentials();
    } catch {
      return false;
    }
  }
  if (!loaded) return false;
  const token = loaded[family === "zai" ? CRED_KEYS.zaiAccessToken : CRED_KEYS.bigmodelAccessToken];
  return typeof token === "string" && token.trim().length > 0;
}
