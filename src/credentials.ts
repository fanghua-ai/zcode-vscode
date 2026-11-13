import * as crypto from "crypto";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { createRequire } from "node:module";
import { defaultCandidatePaths } from "./serverPath";
import { JsonRequestError, readJsonRequest } from "./httpJson";
import { logDebug, logInfo, logWarn } from "./log";
import { readDesktopJson, readDesktopJsonWithRetry } from "./desktopJson";
import { recordDiagnosticEvent } from "./diagnostics";

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
  return value.startsWith("enc:");
}

export function decryptValue(value: string, key: Buffer): string {
  if (!isEncrypted(value)) return value;

  if (!value.startsWith(ENC_PREFIX)) throw new Error("Unsupported credential encryption format");
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

let desktopCredentialBinary: string | undefined;

export function setDesktopCredentialBinary(binary: string): void {
  desktopCredentialBinary = binary;
}

function readSystemCredentialKey(): Buffer {
  const candidates = [desktopCredentialBinary, ...defaultCandidatePaths(process.platform, process.env, os.homedir())];
  const nativeRequire = createRequire(__filename);
  const platformPrefix = `keyring-${process.platform}-${process.arch}`;
  const account = crypto.createHash("sha256").update(path.resolve(v2Dir(), "credentials.json")).digest("hex");
  for (const binary of candidates) {
    if (!binary) continue;
    const modules = path.resolve(path.dirname(binary), "..", "app.asar.unpacked", "node_modules", "@napi-rs");
    let packages: string[];
    try { packages = fs.readdirSync(modules); } catch { continue; }
    for (const name of packages) {
      if (name !== platformPrefix && !name.startsWith(platformPrefix + "-")) continue;
      try {
        const directory = path.join(modules, name);
        const binding = fs.readdirSync(directory).find(file => /^keyring\..+\.node$/.test(file));
        if (!binding) continue;
        const { Entry } = nativeRequire(path.join(directory, binding));
        const password = new Entry("ZCode Credential Encryption", account, { linux: { store: "secret-service" } }).getPassword();
        if (typeof password === "string" && /^[A-Za-z0-9_-]{43}$/.test(password)) return Buffer.from(password, "base64url");
      } catch { /* Try the next installed binding. */ }
    }
  }
  throw new Error("ZCode system credential store unavailable");
}

function decryptDesktopValue(value: string, env: NodeJS.ProcessEnv, keyFor: (source: string) => Buffer): string {
  if (!value.startsWith("enc:v2:")) return decryptValue(value, deriveCipherKey(resolveCredentialSecret(env)));
  const match = /^enc:v2:(os|env):([a-f0-9]{24}):([A-Za-z0-9_.-]+)$/.exec(value);
  if (!match) throw new Error("Invalid ZCode credential envelope");
  const [, source, fingerprint, payload] = match;
  const key = keyFor(source);
  if (crypto.createHash("sha256").update(key).digest("hex").slice(0, 24) !== fingerprint) {
    throw new Error("ZCode credential key mismatch");
  }
  return decryptValue(ENC_PREFIX + payload, key);
}

function desktopKeyReader(env: NodeJS.ProcessEnv): (source: string) => Buffer {
  const keys = new Map<string, Buffer | null>();
  return source => {
    if (!keys.has(source)) {
      keys.set(source, null);
      if (source === "os") keys.set(source, readSystemCredentialKey());
      else {
        const explicit = env.ZCODE_CREDENTIAL_SECRET;
        const configured = env.ZCODE_CREDENTIAL_SECRET_FILE;
        if (explicit && configured) throw new Error("Conflicting ZCode credential secret sources");
        if (explicit) keys.set(source, deriveCipherKey(explicit));
        else {
          const file = configured || path.join(v2Dir(), "credential-secret");
          const info = fs.statSync(file);
          if (!info.isFile() || (!configured && process.platform !== "win32" && (info.mode & 0o077))) {
            throw new Error("Invalid ZCode credential secret file");
          }
          const secret = fs.readFileSync(file, "utf8");
          if (Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 4096) throw new Error("Invalid ZCode credential secret length");
          keys.set(source, deriveCipherKey(secret));
        }
      }
    }
    const key = keys.get(source);
    if (!key) throw new Error("ZCode credential key unavailable");
    return key;
  };
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
  const keyFor = desktopKeyReader(env);

  const result: Record<string, string> = {};
  let failed = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && isEncrypted(v)) {
      try {
        result[k] = decryptDesktopValue(v, env, keyFor);
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

/** Diagnose only credentials relevant to the selected login, after startup fails. */
export async function desktopLoginCredentialIssue(family: PlanFamily, startPlan: boolean): Promise<string | undefined> {
  try {
    const raw = await readDesktopJsonWithRetry<Record<string, string>>(path.join(v2Dir(), "credentials.json"));
    const key = startPlan ? CRED_KEYS.zcodeJwtToken
      : family === "bigmodel" ? CRED_KEYS.bigmodelAccessToken : CRED_KEYS.zaiAccessToken;
    const value = raw[key];
    if (typeof value !== "string" || !isEncrypted(value)) return;
    if (!value.startsWith(ENC_PREFIX) && !/^enc:v2:(os|env):/.test(value)) {
      return "ZCODE_CREDENTIAL_FORMAT_UNSUPPORTED";
    }
    if (value.startsWith("enc:v2:os:") && !maybeDecryptSecret(value)) {
      return "ZCODE_CREDENTIAL_KEYCHAIN_UNAVAILABLE";
    }
  } catch { /* Keep the original login failure if the file cannot be inspected. */ }
}

export function maybeDecryptSecret(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (!value) return "";
  if (!isEncrypted(value)) return value;
  try {
    return decryptDesktopValue(value, env, desktopKeyReader(env));
  } catch {
    return "";
  }
}

interface PlanResponse {
  code?: number | string;
  msg?: string;
  success?: boolean;
  data?: unknown;
  httpStatus?: number;
}

class PlanAuthError extends Error {
  readonly code = "PLAN_AUTH_FAILED";
  constructor(readonly stage: string, readonly reason: string, readonly response?: PlanResponse) {
    // Only fixed local reasons reach errors/logs; never interpolate a server message.
    super(`Plan login ${stage}: ${reason}`);
    this.name = "PlanAuthError";
  }
}

function resultCode(code: unknown): number | string | undefined {
  return typeof code === "number" && Number.isFinite(code) ? code
    : typeof code === "string" && /^-?\d{1,12}$/.test(code) ? code : undefined;
}

/** Safe diagnostic projection: no response body, URL, error message or credential. */
export function planAuthErrorDetails(error: unknown) {
  const value = error as { code?: unknown; status?: unknown; stage?: unknown; message?: unknown; resultCode?: unknown } | null;
  const code = typeof value?.code === "string" && ["HTTP_STATUS", "INVALID_JSON", "RESPONSE_TOO_LARGE", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "ENOTFOUND", "ECONNREFUSED", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT"].includes(value.code) ? value.code : undefined;
  const response = error instanceof PlanAuthError ? error.response : undefined;
  const category = code === "HTTP_STATUS" ? "http" : code === "ETIMEDOUT" ? "timeout"
    : code === "INVALID_JSON" || code === "RESPONSE_TOO_LARGE" ? "invalid_response"
    : code ? "network" : error instanceof PlanAuthError ? (response && !bizOk(response) ? "business" : "invalid_response") : "unknown";
  const reason = error instanceof PlanAuthError ? error.reason
    : typeof value?.message === "string" && /^project_token_(?:account_changed|project_unavailable|invalid_response|key_unavailable|disabled|expired)$/.test(value.message) ? value.message : undefined;
  return {
    code: code ?? (error instanceof PlanAuthError ? error.code : "UNKNOWN_ERROR"), category, reason,
    status: response?.httpStatus ?? (typeof value?.status === "number" ? value.status : undefined),
    resultCode: resultCode(response?.code ?? value?.resultCode),
    responseReason: error instanceof JsonRequestError ? error.responseReason : undefined,
    stage: error instanceof PlanAuthError ? error.stage
      : typeof value?.stage === "string" && ["customer_info", "list_keys", "create_key", "copy_secret", "issue_project_token", "subscription_list", "start_plan_balance", "quota"].includes(value.stage) ? value.stage : undefined,
  };
}

function requestStage(url: string, method: string): string {
  const pathname = new URL(url).pathname;
  return pathname.endsWith("getCustomerInfo") ? "customer_info"
    : pathname.endsWith("/access_tokens") ? "issue_project_token"
    : pathname.endsWith("/subscription/list") ? "subscription_list"
    : pathname.endsWith("/zcode-plan/billing/balance") ? "start_plan_balance"
    : pathname.includes("/copy/") ? "copy_secret"
    : pathname.endsWith("/api_keys") ? (method === "POST" ? "create_key" : "list_keys") : "quota";
}

async function readPlanJson(url: string, method: string, start: Parameters<typeof readJsonRequest>[0]): Promise<PlanResponse> {
  const stage = requestStage(url, method);
  let status: number | undefined;
  try {
    const raw = await readJsonRequest(start, 15000, value => { status = value; });
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PlanAuthError(stage, "invalid_response", { httpStatus: status });
    const response = { ...raw, httpStatus: status } as PlanResponse;
    logDebug("Plan request completed", { stage, method, host: new URL(url).hostname, status,
      resultCode: resultCode(response.code), accepted: bizOk(response) });
    return response;
  } catch (error) {
    const target = new URL(url);
    const details = { ...planAuthErrorDetails(error), stage, method, host: target.hostname, status,
      ...(stage === "start_plan_balance" ? { appVersion: target.searchParams.get("app_version") } : {}) };
    logWarn("Plan request failed", details);
    recordDiagnosticEvent("plan_request_failed", details);
    throw Object.assign(error instanceof Error ? error : new Error("Plan request failed"), { stage });
  }
}

async function httpGetJson(url: string, headers: Record<string, string>): Promise<PlanResponse> {
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
): Promise<PlanResponse> {
  return readPlanJson(url, "GET", receive => https.get(url, { headers }, receive));
}

function httpPostJson(
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<PlanResponse> {
  const postData = JSON.stringify(body);
  const target = new URL(url);
  return readPlanJson(url, "POST", receive => {
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
  });
}

interface Organization {
  organizationId: string;
  organizationName?: string;
  projects: Project[];
}

interface Project {
  projectId: string;
  projectName?: string;
  projectType?: number | string;
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

function authHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/**
 * Match Desktop: personal plans exclude team projects, prefer the named default
 * organization/project, then use the first available entry. Explicit teams keep
 * their selected IDs and never fall back to a personal project.
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

  const organizations = (data as { organizations?: Organization[] })?.organizations;
  const orgs = (Array.isArray(organizations) ? organizations : []).map(org => ({
    ...org,
    projects: (Array.isArray(org?.projects) ? org.projects : []).filter(project =>
      typeof project?.projectId === "string" && project.projectId.trim() && String(project.projectType ?? "").trim() !== "2"),
  })).filter(org => typeof org.organizationId === "string" && org.organizationId.trim() && org.projects.length);
  const org = orgs.find(item => typeof item.organizationName === "string" && item.organizationName.includes("默认机构")) ?? orgs[0];
  if (!org?.organizationId) {
    logWarn("Plan organization unavailable", { stage: "select_organization", candidates: orgs.length });
    return null;
  }
  logDebug("Plan organization selected", { stage: "select_organization", candidates: orgs.length,
    organizationHash: authHash(org.organizationId) });
  const projects = org.projects;
  const proj = projects.find(item => typeof item.projectName === "string" && item.projectName.includes("默认项目")) ?? projects[0];
  if (!proj?.projectId) return null;
  logDebug("Plan project selected", { stage: "select_project", candidates: projects.length,
    projectHash: authHash(proj.projectId) });
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
    if (bizOk(copyResp)) {
      const value = (copyResp.data as { secretKey?: unknown } | undefined)?.secretKey;
      const secret = typeof value === "string" ? value.trim() : "";
      if (secret) {
        logDebug("Plan key secret available", { stage: "copy_secret", keyHash: authHash(apiKey) });
        return `${apiKey}.${secret}`;
      }
    }
    if (requireSecret) throw new PlanAuthError("copy_secret", bizOk(copyResp) ? "missing_secret" : "rejected", copyResp);
  } catch (error) {
    if (requireSecret) throw error;
    // BigModel legacy plans may accept the raw key; Z.ai must never do so.
    logWarn("Plan key copy unavailable", { ...planAuthErrorDetails(error), stage: "copy_secret" });
  }
  return apiKey;
}

function bizOk(resp: PlanResponse): boolean {
  return resp.success !== false && (resp.code == null
    || [0, 200, "0", "200"].includes(resp.code));
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
    typeof key?.apiKey === "string" && !!key.apiKey.trim() &&
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
    if (!bizOk(infoResp)) throw new PlanAuthError("customer_info", "rejected", infoResp);
    orgProj = pickOrgAndProject(infoResp.data);
  }
  if (!orgProj) {
    throw new PlanAuthError("select_project", "project_unavailable");
  }
  if (prefer) logDebug("Plan team project selected", { stage: "select_project",
    organizationHash: authHash(prefer.organizationId), projectHash: authHash(prefer.projectId) });

  const keysUrl = `${host}/api/biz/v1/organization/${encodeURIComponent(
    orgProj.organizationId
  )}/projects/${encodeURIComponent(orgProj.projectId)}/api_keys`;
  const keysResp = await httpGetJson(keysUrl, headers);
  if (!bizOk(keysResp)) throw new PlanAuthError("list_keys", "rejected", keysResp);
  if (!Array.isArray(keysResp.data)) throw new PlanAuthError("list_keys", "invalid_response", keysResp);
  const keys = keysResp.data as ApiKey[];

  if (prefer) {
    const existing = keys.find(isUsableTeamPlanKey);
    if (existing) {
      logInfo("Using BigModel team-plan API key", {
        stage: "list_keys", keyHash: authHash(existing.apiKey),
        keyType: existing.keyType,
      });
      return withCopiedSecret(keysUrl, headers, existing.apiKey.trim(), requireSecret);
    }

    const createResp = await httpPostJson(keysUrl, headers, {
      name: ZCODE_TEAM_API_KEY_NAME,
      keyType: TEAM_PLAN_KEY_TYPE,
    });
    if (!bizOk(createResp)) throw new PlanAuthError("create_key", "rejected", createResp);
    const created = createResp.data as ApiKey | undefined;
    if (!isUsableTeamPlanKey(created)) {
      throw new PlanAuthError("create_key", "team_key_unavailable", createResp);
    }
    logInfo("Created BigModel team-plan API key", {
      stage: "create_key", keyHash: authHash(created.apiKey),
    });
    return withCopiedSecret(keysUrl, headers, created.apiKey.trim(), requireSecret);
  }

  const personal = keys.find(k => k?.name === ZCODE_API_KEY_NAME);
  if (personal && (typeof personal.apiKey !== "string" || !personal.apiKey.trim())) throw new PlanAuthError("list_keys", "key_unavailable", keysResp);
  if (personal?.apiKey) {
    logInfo("Using personal plan API key", { stage: "list_keys", family, keyHash: authHash(personal.apiKey) });
    return withCopiedSecret(keysUrl, headers, personal.apiKey.trim(), requireSecret);
  }

  const createResp = await httpPostJson(keysUrl, headers, {
    name: ZCODE_API_KEY_NAME,
  });
  if (!bizOk(createResp)) throw new PlanAuthError("create_key", "rejected", createResp);

  const newKey = createResp.data as ApiKey | undefined;
  if (typeof newKey?.apiKey !== "string" || !newKey.apiKey.trim()) {
    throw new PlanAuthError("create_key", "key_unavailable", createResp);
  }
  return withCopiedSecret(keysUrl, headers, newKey.apiKey.trim(), requireSecret);
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

/** PAT-based Coding Plan authentication shipped in the public 3.15.1 source. */
export function usesProjectTokens(version?: string | null): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version ?? "");
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 3 || (major === 3 && (minor > 15 || (minor === 15 && patch >= 1)));
}

/** Only a desktop known to predate 3.15.1 stores long-lived account keys. */
export function usesLegacyPlanKeys(version?: string | null): boolean {
  return /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version ?? "") && !usesProjectTokens(version);
}

// The issue endpoint requires a client version. An unreadable desktop
// version is treated as the oldest release that issues project tokens.
const PROJECT_TOKEN_FALLBACK_VERSION = "3.15.1";
const PROJECT_TOKEN_RETRY_MS = 5_000;

function isTransientPlanError(error: unknown): boolean {
  if (error instanceof JsonRequestError) {
    const status = error.status ?? 0;
    return error.code === "HTTP_STATUS" && (status === 429 || (status >= 500 && status < 600));
  }
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "ENOTFOUND", "ECONNREFUSED"].includes(code);
}

/** Only a missing issue endpoint shows that the service predates project tokens. */
function projectTokensUnsupported(error: unknown): boolean {
  const unsupported = ["404", "405", "501"];
  if (error instanceof JsonRequestError) {
    return (error as { stage?: unknown }).stage === "issue_project_token" &&
      error.code === "HTTP_STATUS" && unsupported.includes(String(error.status));
  }
  return error instanceof PlanAuthError && error.stage === "issue_project_token" &&
    error.reason === "rejected" && unsupported.includes(String(error.response?.code));
}

export interface PlanAuth {
  apiKey: string;
  /** Present only for short-lived project tokens; never persist these credentials. */
  apiKeyId?: string;
  accountScope?: string;
}

type CachedPlanToken = {
  scope: string;
  value?: PlanAuth;
  refreshAt?: number;
  expiresAt?: number;
  pending?: Promise<PlanAuth>;
};
// Concurrent personal and team exchanges need separate slots. The scope still
// includes the OAuth credential, so signing in again cannot reuse the old token.
const planTokens = new Map<string, CachedPlanToken>();
// Legacy keys have no expiry. Reuse only briefly during startup, and read
// the current OAuth credential on every call so account changes invalidate it.
const legacyPlanKeys = new Map<string, CachedPlanToken>();

/** A 401 must invalidate OAuth exchanges before either runtime refresh path runs. */
export function invalidatePlanAuth(apiKey: string): void {
  for (const cache of [planTokens, legacyPlanKeys]) {
    for (const [scope, entry] of cache) {
      if (entry.value?.apiKey === apiKey) cache.delete(scope);
    }
  }
}

async function resolveLegacyPlanKey(family: PlanFamily, oauth: string, prefer?: OrgProject,
  rejectedFingerprint?: string): Promise<PlanAuth> {
  const scope = crypto.createHash("sha256").update(JSON.stringify([
    zcodeDir(), family, oauth, prefer?.organizationId, prefer?.projectId,
  ])).digest("hex");
  let entry = legacyPlanKeys.get(scope);
  if (!entry || entry.scope !== scope) {
    entry = { scope };
    legacyPlanKeys.set(scope, entry);
  }
  if (rejectedFingerprint && entry.value &&
      crypto.createHash("sha256").update(entry.value.apiKey).digest("hex") === rejectedFingerprint) {
    entry.value = undefined;
  }
  if (entry.value && Date.now() < entry.refreshAt!) {
    logDebug("Reusing recent plan login", { family, team: !!prefer });
    return entry.value;
  }
  if (entry.pending) return entry.pending;
  const current = entry;
  current.pending = (async () => {
    // Desktop already exchanged oauth:zai:access_token into a business token.
    const login = oauth.trim().replace(/^Bearer\s+/i, "");
    const authorization = family === "zai" ? `Bearer ${login}` : login;
    const apiKey = await resolveApiKey(family, authorization, prefer);
    const latest = await readCredentialsWithRetry();
    if (legacyPlanKeys.get(scope) !== current ||
        latest[family === "zai" ? CRED_KEYS.zaiAccessToken : CRED_KEYS.bigmodelAccessToken] !== oauth) {
      throw new Error("project_token_account_changed");
    }
    current.value = { apiKey };
    current.refreshAt = Date.now() + 30_000;
    logInfo("Plan login resolved", { family, team: !!prefer, stage: "exchange_api_key", credentialHash: authHash(apiKey) });
    return current.value;
  })();
  try { return await current.pending; }
  finally { current.pending = undefined; }
}

async function resolveProjectToken(
  family: PlanFamily, oauth: string, version: string, prefer?: OrgProject,
  rejectedFingerprint?: string
): Promise<PlanAuth> {
  const scope = crypto.createHash("sha256").update(JSON.stringify([
    zcodeDir(), family, oauth, prefer?.organizationId, prefer?.projectId, version,
  ])).digest("hex");
  let entry = planTokens.get(scope);
  if (!entry || entry.scope !== scope) {
    entry = { scope };
    planTokens.set(scope, entry);
  }
  if (rejectedFingerprint && entry.value &&
      crypto.createHash("sha256").update(entry.value.apiKey).digest("hex") === rejectedFingerprint) {
    entry.value = undefined;
  }
  if (entry.value && Date.now() < entry.refreshAt!) return entry.value;
  if (entry.pending) return entry.pending;
  const current = entry;
  current.pending = (async () => {
    const login = oauth.trim().replace(/^Bearer\s+/i, "");
    const info = await httpGetJson(`${PLAN_HOST[family]}/api/biz/customer/getCustomerInfo`, { Authorization: login });
    const data = projectTokenData(info, "customer_info") as { organizations?: Organization[] };
    const location = pickOrgAndProject(data, prefer);
    if (!location || (prefer && !data.organizations?.some(org =>
      org.organizationId === prefer.organizationId && org.projects?.some(project => project.projectId === prefer.projectId)
    ))) throw new PlanAuthError("select_project", "project_unavailable", info);
    if (prefer) logDebug("Plan team project selected", { stage: "select_project",
      organizationHash: authHash(prefer.organizationId), projectHash: authHash(prefer.projectId) });
    const url = `${PLAN_HOST[family]}/api/biz/v1/organization/${encodeURIComponent(location.organizationId)}/projects/${encodeURIComponent(location.projectId)}/api_keys`;
    const headers = bizHeaders(!prefer && family === "zai" ? `Bearer ${login}` : login, prefer);
    const keysResponse = await httpGetJson(url, headers);
    const keys = projectTokenData(keysResponse, "list_keys");
    if (!Array.isArray(keys)) throw new PlanAuthError("list_keys", "invalid_response", keysResponse);
    const name = prefer ? ZCODE_TEAM_API_KEY_NAME : ZCODE_API_KEY_NAME;
    const candidate = keys.find(key => key && typeof key === "object" &&
      "name" in key && key.name === name && (!prefer || ("keyType" in key && key.keyType === TEAM_PLAN_KEY_TYPE)));
    const key = candidate ?? projectTokenData(await httpPostJson(url, headers, {
      name, ...(prefer ? { keyType: TEAM_PLAN_KEY_TYPE } : {}), usageScene: 1,
    }), "create_key");
    if (!key || typeof key !== "object" || !("apiKey" in key) ||
        typeof key.apiKey !== "string" || !key.apiKey.trim() ||
        (prefer && (!("name" in key) || key.name !== name || !("keyType" in key) || key.keyType !== TEAM_PLAN_KEY_TYPE))) throw new PlanAuthError(candidate ? "list_keys" : "create_key", "key_unavailable");
    const apiKeyId = key.apiKey.trim();
    logDebug("Plan project key available", { stage: candidate ? "list_keys" : "create_key",
      family, team: !!prefer, keyHash: authHash(apiKeyId) });
    const started = Date.now();
    const tokenResponse = await httpPostJson(`${url}/${encodeURIComponent(apiKeyId)}/access_tokens`,
      { Authorization: `Bearer ${login}` }, { clientType: "zcode", clientVersion: version });
    const token = projectTokenData(tokenResponse, "issue_project_token") as {
        enable?: boolean; accessToken?: string; tokenType?: string; expiresAt?: number; expiresIn?: number;
      };
    if (token.enable === false) throw new PlanAuthError("issue_project_token", "disabled", tokenResponse);
    if ((token.enable !== undefined && token.enable !== true) || token.tokenType !== "Bearer" ||
        typeof token.accessToken !== "string" || !token.accessToken.trim() ||
        typeof token.expiresAt !== "number" || !Number.isFinite(token.expiresAt) ||
        typeof token.expiresIn !== "number" || !Number.isFinite(token.expiresIn) || token.expiresIn <= 0) {
      throw new PlanAuthError("issue_project_token", "invalid_response", tokenResponse);
    }
    const expiresAt = Math.min(token.expiresAt * 1000, started + token.expiresIn * 1000);
    if (expiresAt <= Date.now()) throw new PlanAuthError("issue_project_token", "expired", tokenResponse);
    const latest = await readCredentialsWithRetry();
    if (planTokens.get(scope) !== current ||
        latest[family === "zai" ? CRED_KEYS.zaiAccessToken : CRED_KEYS.bigmodelAccessToken] !== oauth) {
      throw new Error("project_token_account_changed");
    }
    current.value = { apiKey: token.accessToken.trim(), apiKeyId, accountScope: scope };
    current.expiresAt = expiresAt;
    current.refreshAt = expiresAt - Math.min(120_000, (expiresAt - started) / 5);
    logInfo("Plan login resolved", { family, team: !!prefer, stage: "exchange_project_token", credentialHash: authHash(token.accessToken.trim()) });
    return current.value;
  })().catch(async error => {
    // Rejected (401) tokens were cleared above, so only a still-valid token survives an outage.
    if (planTokens.get(scope) !== current || !current.value || !isTransientPlanError(error) ||
        Date.now() >= current.expiresAt!) throw error;
    const latest = await readCredentialsWithRetry().catch(() => null);
    if (planTokens.get(scope) !== current ||
        latest?.[family === "zai" ? CRED_KEYS.zaiAccessToken : CRED_KEYS.bigmodelAccessToken] !== oauth) {
      throw new Error("project_token_account_changed");
    }
    if (!current.value || Date.now() >= current.expiresAt!) throw error;
    current.refreshAt = Math.min(Date.now() + PROJECT_TOKEN_RETRY_MS, current.expiresAt!);
    const details = { ...planAuthErrorDetails(error), family, team: !!prefer };
    logWarn("Plan project token refresh deferred", details);
    recordDiagnosticEvent("plan_refresh_deferred", details);
    return current.value;
  });
  try { return await current.pending; }
  finally { current.pending = undefined; }
}

function projectTokenData(response: PlanResponse, stage: string): unknown {
  if (!bizOk(response)) throw new PlanAuthError(stage, "rejected", response);
  if (response.code == null) throw new PlanAuthError(stage, "invalid_response", response);
  if (!response.data || typeof response.data !== "object") throw new PlanAuthError(stage, "invalid_response", response);
  return response.data;
}

export async function tryPlanOAuth(
  family: PlanFamily,
  prefer?: OrgProject,
  appVersion?: string | null,
  rejectedFingerprint?: string
): Promise<(PlanAuth & { activeProvider: string | null }) | null> {
  let stage = "read_credentials";
  try {
    const creds = await readCredentialsWithRetry();
    const activeProvider = creds[CRED_KEYS.activeProvider] ?? null;
    const protocol = usesProjectTokens(appVersion) ? "project_token" : usesLegacyPlanKeys(appVersion) ? "legacy" : "unknown";
    const storedPersonalAuth = (loaded: Record<string, string>) => {
      if (prefer || protocol !== "unknown") return null;
      const apiKey = readStoredPlanApiKey(`account:${family}-individual-coding-plan`, loaded);
      if (!apiKey || crypto.createHash("sha256").update(apiKey).digest("hex") === rejectedFingerprint) return null;
      logDebug("Using stored personal plan key for an unknown desktop version", { family });
      return { apiKey, activeProvider: loaded[CRED_KEYS.activeProvider] ?? family };
    };
    const tokenKey = family === "zai" ? CRED_KEYS.zaiAccessToken : CRED_KEYS.bigmodelAccessToken;
    const accessToken = creds[tokenKey];
    if (!accessToken?.trim().replace(/^Bearer\s+/i, "")) {
      logWarn("Desktop OAuth token is unavailable", { family });
      return storedPersonalAuth(creds);
    }
    // This entry point reads Desktop credentials, not a CLI OAuth callback.
    logDebug("Plan desktop credential selected", { family, team: !!prefer, stage: "read_credentials",
      credentialKind: family === "zai" ? "business" : "oauth", credentialHash: authHash(accessToken), protocol });
    if (protocol !== "legacy") {
      stage = "exchange_project_token";
      try {
        const auth = await resolveProjectToken(family, accessToken,
          protocol === "project_token" ? appVersion! : PROJECT_TOKEN_FALLBACK_VERSION, prefer, rejectedFingerprint);
        return { ...auth, activeProvider: activeProvider ?? family };
      } catch (error) {
        if (protocol !== "unknown") throw error;
        const unsupported = projectTokensUnsupported(error);
        if (!unsupported && (prefer || !isTransientPlanError(error))) throw error;
        const details = { ...planAuthErrorDetails(error), family, team: !!prefer };
        if (!prefer) {
          const latest = await readCredentialsWithRetry();
          if (latest[tokenKey] !== accessToken) throw new Error("project_token_account_changed");
          const stored = storedPersonalAuth(latest);
          if (stored) {
            logWarn("Project token unavailable for an unknown desktop version; using a stored personal key", details);
            recordDiagnosticEvent("plan_project_token_fallback", details);
            return stored;
          }
        }
        // A temporary outage permits reusing a stored key, but only an unsupported endpoint permits a legacy exchange.
        if (!unsupported) throw error;
        logWarn("Project token unavailable for an unknown desktop version; trying legacy plan key", details);
        recordDiagnosticEvent("plan_project_token_fallback", details);
      }
    }
    stage = "exchange_api_key";
    const auth = await resolveLegacyPlanKey(family, accessToken, prefer, rejectedFingerprint);
    return { ...auth, activeProvider: activeProvider ?? family };
  } catch (e) {
    const details = planAuthErrorDetails(e);
    logWarn("Plan API key exchange failed", { ...details, family, team: !!prefer, exchange: stage, stage: details.stage ?? stage });
    recordDiagnosticEvent("plan_exchange_failed", { ...details, family, team: !!prefer, exchange: stage });
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
    return fetchStartPlanQuota(plan.family, appVersion);
  }

  // Team plans exchange a key with the desktop's org and project.
  // Personal Coding Plans use the desktop-stored account key when there is
  // exactly one, so a multi-org account is not assigned by display name.
  let apiKey = "";
  if (!plan.team && usesLegacyPlanKeys(appVersion)) {
    apiKey = readStoredPlanApiKey(`account:${plan.family}-${plan.kind}`) ?? "";
  }
  if (!apiKey) {
    apiKey = (await tryPlanOAuth(plan.family, plan.team, appVersion))?.apiKey?.trim() ?? "";
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
  code?: number | string;
  success?: boolean;
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
      entitlements?: Array<{ effective_at?: number | string | null }>;
    }>;
    balances?: Array<{
      user_plan_id?: string;
      plan_id?: string;
      show_name?: string;
      meter?: string;
      total_units?: number | string | null;
      remaining_units?: number | string | null;
      expires_at?: number | string | null;
      capabilities?: string[];
    }>;
  };
}

const START_PLAN_BALANCE_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance";

// Match the desktop's official-glm-model-id mapping; unknown IDs are unchanged.
const OFFICIAL_GLM_MODEL_NAMES = new Map([
  "GLM-5.3", "GLM-5.3-Flash", "GLM-5V-Turbo", "GLM-5.2", "GLM-5.1",
  "GLM-5.1-Highspeed", "GLM-5", "GLM-5-Turbo", "GLM-4.7", "GLM-4.7-FlashX",
  "GLM-4.7-Flash", "GLM-4.6", "GLM-4.5-Air", "GLM-4.5", "GLM-4.6V",
  "GLM-4.6V-Flash", "GLM-4.6V-FlashX", "GLM-4.1V-Thinking-FlashX",
  "GLM-4.1V-Thinking-Flash", "GLM-4-FlashX-250414", "GLM-4-Flash-250414", "GLM-4V-Flash",
].map(name => [name.toLowerCase(), name]));

/** Start Plan consumes the desktop's ZCode JWT, never a personal/project API key. */
export async function readStartPlanAuth(family: PlanFamily): Promise<PlanAuth | null> {
  let credentials: Record<string, string>;
  try {
    credentials = await readCredentialsWithRetry();
  } catch {
    logDebug("Start Plan credential unavailable", { family, reason: "credentials_read_failed" });
    return null;
  }
  const active = credentials[CRED_KEYS.activeProvider]?.trim();
  if (active && active !== family) {
    logDebug("Start Plan credential unavailable", { family, reason: "active_provider_mismatch" });
    return null;
  }
  // BigModel's shared JWT belongs to the active OAuth provider. A scoped
  // provider copy is the desktop's fallback when that ownership is unknown.
  const shared = family === "zai" || active === family
    ? credentials[CRED_KEYS.zcodeJwtToken]?.trim() : "";
  const scoped = shared ? null : readStoredPlanApiKey(`account:${family}-start-plan`, credentials);
  const jwt = (shared || scoped || "")
    .replace(/^Bearer\s+/i, "").trim();
  logDebug("Start Plan credential lookup", { family, source: jwt ? (shared ? "desktop_jwt" : "provider_credential") : "missing" });
  return jwt ? { apiKey: jwt } : null;
}

export async function readStartPlanAccess(family: PlanFamily, appVersion?: string | null): Promise<{
  auth: PlanAuth; models: string[]; quota: PlanQuotaLimit[];
} | null> {
  let auth = await readStartPlanAuth(family);
  if (!auth) return null;

  const url = new URL(START_PLAN_BALANCE_URL);
  // The desktop app version affects which Start Plan entitlements the service
  // returns. Never substitute the extension version for the desktop version.
  if (appVersion && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(appVersion)) {
    url.searchParams.set("app_version", appVersion);
  }
  const version = url.searchParams.get("app_version");
  const headers: Record<string, string> = {};
  if (version) headers["X-ZCode-App-Version"] = version;
  // The balance endpoint requires the device identity already created by ZCode.
  try {
    const state = readDesktopJson<{ deviceMid?: unknown }>(path.join(v2Dir(), "telemetry-state.json"));
    const deviceMid = typeof state.deviceMid === "string" ? state.deviceMid.trim() : "";
    if (deviceMid && /^[\x21-\x7e]+$/.test(deviceMid)) headers["X-Device-Mid"] = deviceMid;
  } catch { /* Desktop owns the device identity. Leave it absent if unreadable. */ }
  const context = { family, appVersion: version, hasDeviceMid: !!headers["X-Device-Mid"] };
  logInfo("Checking Start Plan access", context);
  recordDiagnosticEvent("start_plan_check", context);
  let response: StartPlanBalanceResponse | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await httpGetJson(url.toString(), { ...headers, Authorization: `Bearer ${auth.apiKey}` }).then(
      value => ({ value }), (error: unknown) => ({ error }),
    );
    const current = await readStartPlanAuth(family);
    if (current?.apiKey === auth.apiKey) {
      if ("error" in reply) throw reply.error;
      response = reply.value as StartPlanBalanceResponse;
      break;
    }
    logDebug("Discarding Start Plan balance after desktop credentials changed", { family });
    if (!current) return null;
    auth = current;
  }
  if (!response) return null;
  if (response.success === false || (response.code !== undefined && !["0", "200"].includes(String(response.code)))) {
    const details = { family, stage: "start_plan_balance", resultCode: resultCode(response.code) };
    logWarn("Start Plan balance rejected", details);
    recordDiagnosticEvent("start_plan_rejected", details);
    return null;
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
      ((!id && !name) || id.includes("start-plan") || id.includes("start plan") || name.includes("start-plan") || name.includes("start plan")) &&
      (start === null || start <= now) &&
      (end === null || end > now);
  });
  if (activePlans.length === 0) {
    logInfo("No active Start Plan found", { family, planCount: plans.length });
    recordDiagnosticEvent("start_plan_unavailable", { family, reason: "no_active_plan", planCount: plans.length });
    return null;
  }

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

  const modelIds = ownedBalances.filter(balance => {
    const expires = finitePositive(balance.expires_at);
    return expires === null || expires > now;
  }).flatMap(balance => {
    const capabilities = (balance.capabilities ?? []).filter(value => typeof value === "string")
      .map(value => value.trim()).filter(value => /^model:/i.test(value)).map(value => value.slice(6).trim()).filter(Boolean);
    return capabilities.length ? capabilities : [balance.show_name?.trim() || ""];
  }).filter(Boolean).map(value => OFFICIAL_GLM_MODEL_NAMES.get(value.toLowerCase()) ?? value);
  const seenModels = new Set<string>();
  const models = modelIds.filter(value => {
    const key = value.toLowerCase();
    if (seenModels.has(key)) return false;
    seenModels.add(key);
    return true;
  });
  const effectiveTimes = activePlans.flatMap(plan => plan.entitlements?.length
    ? plan.entitlements.map(entry => finitePositive(entry.effective_at)) : [finitePositive(plan.starts_at)]);
  if (!models.length && effectiveTimes.length && effectiveTimes.every(time => time !== null && time > now)) {
    recordDiagnosticEvent("start_plan_unavailable", { family, reason: "entitlements_not_effective" });
    return null;
  }
  logDebug("Start Plan entitlement resolved", { stage: "start_plan_balance", family, code: resultCode(response.code),
    activePlanCount: activePlans.length, modelCount: models.length });
  recordDiagnosticEvent("start_plan_catalog", { family, modelCount: models.length,
    hasGlm53: seenModels.has("glm-5.3"), hasGlm53Flash: seenModels.has("glm-5.3-flash") });
  const quota = ownedBalances
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
  return { auth, models, quota };
}

async function fetchStartPlanQuota(family: PlanFamily, appVersion?: string | null): Promise<PlanQuotaLimit[]> {
  return (await readStartPlanAccess(family, appVersion))?.quota ?? [];
}

/** Null means the service did not establish whether the subscription exists. */
export async function hasPersonalCodingPlan(family: PlanFamily, apiKey: string): Promise<boolean | null> {
  const response = await httpGetJson(`${PLAN_HOST[family]}/api/biz/subscription/list`, { Authorization: apiKey });
  const data = response.data;
  let entitled: boolean | null = null;
  if (bizOk(response) && Array.isArray(data)) {
    entitled = false;
    for (const item of data) {
      const plan = item as { productId?: string; productName?: string; status?: string; inCurrentPeriod?: boolean } | null;
      if (!plan || ![plan.productId, plan.productName].some(value => typeof value === "string" && value.toLowerCase().includes("coding"))) continue;
      if (plan.status === "VALID" && plan.inCurrentPeriod === true) {
        entitled = true;
        break;
      }
      if (typeof plan.status !== "string" || typeof plan.inCurrentPeriod !== "boolean") entitled = null;
    }
  }
  logDebug("Personal Coding Plan entitlement resolved", { stage: "personal_plan_entitlement", family, code: resultCode(response.code), entitled });
  return entitled;
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
