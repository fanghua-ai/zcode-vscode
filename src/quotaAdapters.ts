import * as http from "http";
import * as https from "https";
import type { QuotaLine, QuotaMetric } from "./credentials";

export type QuotaAdapterAuth = "none" | "bearer" | "header";
export type QuotaAdapterApiKeySource = "secretStorage" | "zcode";
export type QuotaPercentScale = "0-1" | "0-100";
export type QuotaResetFormat = "auto" | "unix-seconds" | "unix-milliseconds" | "iso";
export type QuotaMetricFormat = "number" | "currency";
export type QuotaMetricOperation = "sum" | "subtract" | "multiply" | "divide" | "min" | "max";

export interface QuotaMetricCalculation {
  operation: QuotaMetricOperation;
  paths: string[];
  /** Divide the calculated result by a fixed unit scale, for example cents to currency units. */
  divisor?: number;
}

export interface QuotaLimitCalculation {
  limitPath: string;
  usedPath: string;
  limitDivisor?: number;
  usedDivisor?: number;
}

export interface QuotaMetricMapping {
  label: string;
  valuePath?: string;
  /** Divide a directly mapped value by this amount, for example cents to currency units. */
  valueDivisor?: number;
  calculation?: QuotaMetricCalculation;
  format?: QuotaMetricFormat;
  currency?: string;
  currencyPath?: string;
  unit?: string;
  period?: string;
  periodPath?: string;
}

export interface QuotaFieldMapping {
  label?: string;
  labelPath?: string;
  remainingPercentPath?: string;
  usedPercentPath?: string;
  remainingCountPath?: string;
  nextResetTimePath?: string;
  resetTimeFormat?: QuotaResetFormat;
  remainingAmountPath?: string;
  currency?: string;
  currencyPath?: string;
  grantedAmountPath?: string;
  toppedUpAmountPath?: string;
  metrics?: QuotaMetricMapping[];
  /** Normalize amount/count values returned in minor units before displaying them. */
  amountDivisor?: number;
  countDivisor?: number;
  /** Derive a remaining count and percentage from total and used numeric values. */
  quotaCalculation?: QuotaLimitCalculation;
  budgetCalculation?: {
    limitPath: string;
    usedPath: string;
    limitDivisor?: number;
    usedDivisor?: number;
  };
}

export interface QuotaAdapterRequest {
  id: string;
  endpoint: string;
  method?: "GET" | "POST";
  requestHeaders?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface QuotaAdapterConfig {
  /** Optional compatibility marker. Omitted settings are interpreted as schema v1. */
  schemaVersion?: 1;
  id: string;
  providerId: string;
  /** Optional exact shortcut template id, used to avoid reusing an unrelated provider key. */
  providerTemplateId?: string;
  /** Trusted provider origin used when ZCode stores no explicit API base URL. */
  providerBaseURL?: string;
  displayName: string;
  endpoint?: string;
  method?: "GET" | "POST";
  auth?: QuotaAdapterAuth;
  apiKeySource?: QuotaAdapterApiKeySource;
  authHeaderName?: string;
  authHeaderPrefix?: string;
  requestHeaders?: Record<string, string>;
  body?: Record<string, unknown>;
  itemsPath?: string;
  percentScale?: QuotaPercentScale;
  allowedCurrencies?: string[];
  requests?: QuotaAdapterRequest[];
  fields: QuotaFieldMapping[];
}

export const DEEPSEEK_QUOTA_ADAPTER: QuotaAdapterConfig = {
  id: "builtin-deepseek-balance",
  providerId: "deepseek",
  providerTemplateId: "deepseek",
  providerBaseURL: "https://api.deepseek.com",
  displayName: "DeepSeek API balance",
  endpoint: "https://api.deepseek.com/user/balance",
  method: "GET",
  auth: "bearer",
  apiKeySource: "zcode",
  itemsPath: "/balance_infos",
  allowedCurrencies: ["CNY", "USD"],
  fields: [{
    labelPath: "/currency",
    remainingAmountPath: "/total_balance",
    currencyPath: "/currency",
    grantedAmountPath: "/granted_balance",
    toppedUpAmountPath: "/topped_up_balance",
  }],
};

export const KIMI_QUOTA_ADAPTER: QuotaAdapterConfig = {
  id: "builtin-kimi-balance",
  providerId: "moonshot-kimi",
  providerTemplateId: "moonshot-kimi",
  providerBaseURL: "https://api.moonshot.cn",
  displayName: "Kimi API balance",
  endpoint: "https://api.moonshot.cn/v1/users/me/balance",
  method: "GET",
  auth: "bearer",
  apiKeySource: "zcode",
  allowedCurrencies: ["CNY"],
  fields: [{
    label: "Kimi API",
    remainingAmountPath: "/data/available_balance",
    currency: "CNY",
    grantedAmountPath: "/data/voucher_balance",
  }],
};

/** Preconfigured adapters use the same credential, request, and mapping path as user adapters. */
export const BUILTIN_QUOTA_ADAPTERS: readonly QuotaAdapterConfig[] = [DEEPSEEK_QUOTA_ADAPTER, KIMI_QUOTA_ADAPTER];

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const FORBIDDEN_HEADERS = new Set([
  "authorization", "proxy-authorization", "host", "content-length", "cookie", "set-cookie",
  "connection", "transfer-encoding", "upgrade",
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export class QuotaAdapterError extends Error {
  constructor(readonly code: "invalid-config" | "missing-secret" | "untrusted-provider-origin" | "request-failed" | "bad-response" | "mapping-failed") {
    super(`Quota adapter ${code}`);
    this.name = "QuotaAdapterError";
  }
}

export function quotaSecretStorageKey(id: string): string {
  if (!SAFE_ID.test(id)) throw new QuotaAdapterError("invalid-config");
  return `zcode.quotaAdapter.${id}`;
}

/** Merge packaged presets with user settings, rejecting ambiguous provider mappings. */
export function buildQuotaAdapterRegistry(userValues: unknown): QuotaAdapterConfig[] {
  const builtins = BUILTIN_QUOTA_ADAPTERS.map(validateQuotaAdapter);
  if (!Array.isArray(userValues)) return builtins;
  const userAdapters: QuotaAdapterConfig[] = [];
  for (const value of userValues) {
    try { userAdapters.push(validateQuotaAdapter(value)); }
    catch { /* Invalid user settings are ignored; plan quota remains the fallback. */ }
  }
  const ids = new Map<string, number>();
  const providers = new Map<string, number>();
  for (const adapter of userAdapters) {
    ids.set(adapter.id, (ids.get(adapter.id) ?? 0) + 1);
    providers.set(adapter.providerId, (providers.get(adapter.providerId) ?? 0) + 1);
  }
  const builtinIds = new Set(builtins.map(adapter => adapter.id));
  const builtinProviders = new Set(builtins.map(adapter => adapter.providerId));
  const uniqueUserAdapters = userAdapters.filter(adapter =>
    ids.get(adapter.id) === 1 && providers.get(adapter.providerId) === 1
      && !builtinIds.has(adapter.id) && !builtinProviders.has(adapter.providerId));
  return [...builtins, ...uniqueUserAdapters];
}

/** Validate settings as untrusted data before using them for a network request. */
export function validateQuotaAdapter(value: unknown): QuotaAdapterConfig {
  if (!isRecord(value)) throw new QuotaAdapterError("invalid-config");
  const schemaVersion = value.schemaVersion === undefined ? 1 : value.schemaVersion;
  const id = readShortText(value.id, 64);
  const providerId = readShortText(value.providerId, 200);
  const providerTemplateId = value.providerTemplateId === undefined ? undefined : readShortText(value.providerTemplateId, 200);
  const providerBaseURL = value.providerBaseURL === undefined ? undefined : readShortText(value.providerBaseURL, 2048);
  const displayName = readShortText(value.displayName, 80);
  const endpoint = value.endpoint === undefined ? undefined : readShortText(value.endpoint, 2048);
  if (schemaVersion !== 1 || !id || !SAFE_ID.test(id) || !providerId || value.providerTemplateId !== undefined && !providerTemplateId
    || value.providerBaseURL !== undefined && !providerBaseURL || !displayName || value.endpoint !== undefined && !endpoint
    || !Array.isArray(value.fields) || value.fields.length < 1 || value.fields.length > 20) {
    throw new QuotaAdapterError("invalid-config");
  }
  if (providerBaseURL) {
    try {
      const base = new URL(providerBaseURL);
      if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error();
    } catch {
      throw new QuotaAdapterError("invalid-config");
    }
  }
  const method = value.method === undefined ? "GET" : value.method;
  const auth = value.auth === undefined ? "bearer" : value.auth;
  const apiKeySource = value.apiKeySource === undefined ? "secretStorage" : value.apiKeySource;
  const percentScale = value.percentScale === undefined ? "0-100" : value.percentScale;
  const authHeaderPrefix = value.authHeaderPrefix === undefined ? "" : value.authHeaderPrefix;
  if ((method !== "GET" && method !== "POST") || !["none", "bearer", "header"].includes(String(auth))
    || !["secretStorage", "zcode"].includes(String(apiKeySource))
    || apiKeySource === "zcode" && auth === "none"
    || (percentScale !== "0-1" && percentScale !== "0-100")
    || typeof authHeaderPrefix !== "string" || authHeaderPrefix.length > 40 || /[\u0000-\u001f\u007f]/.test(authHeaderPrefix)
    || value.authHeaderPrefix !== undefined && auth !== "header") {
    throw new QuotaAdapterError("invalid-config");
  }
  const authHeaderName = value.authHeaderName === undefined ? "x-api-key" : readShortText(value.authHeaderName, 100);
  const normalizedAuthHeaderName = authHeaderName?.toLowerCase() === "authorization" ? "Authorization" : authHeaderName ?? "x-api-key";
  if (auth === "header" && (!authHeaderName || !HEADER_NAME.test(authHeaderName)
    || FORBIDDEN_HEADERS.has(authHeaderName.toLowerCase()) && authHeaderName.toLowerCase() !== "authorization")) {
    throw new QuotaAdapterError("invalid-config");
  }
  const requests = parseRequests(value.requests, endpoint ?? undefined, method as "GET" | "POST", auth as QuotaAdapterAuth, normalizedAuthHeaderName);
  const requestHeaders = validateRequestHeaders(value.requestHeaders, auth as QuotaAdapterAuth, normalizedAuthHeaderName);
  const body = value.body;
  if (body !== undefined && (method !== "POST" || !isRecord(body) || safeJson(body).length > MAX_REQUEST_BYTES)) {
    throw new QuotaAdapterError("invalid-config");
  }
  if (requests && body !== undefined) throw new QuotaAdapterError("invalid-config");
  const itemsPath = value.itemsPath === undefined ? "" : readPointer(value.itemsPath);
  if (itemsPath === null) throw new QuotaAdapterError("invalid-config");
  if (requests && itemsPath) throw new QuotaAdapterError("invalid-config");
  const allowedCurrencies = value.allowedCurrencies;
  if (allowedCurrencies !== undefined && (!Array.isArray(allowedCurrencies) || allowedCurrencies.length > 20 || allowedCurrencies.some(item => typeof item !== "string" || !CURRENCY_CODE.test(item)))) {
    throw new QuotaAdapterError("invalid-config");
  }
  const fields = value.fields.map((raw): QuotaFieldMapping => {
    if (!isRecord(raw)) throw new QuotaAdapterError("invalid-config");
    const field: QuotaFieldMapping = {};
    if (raw.label !== undefined) {
      const label = readShortText(raw.label, 80);
      if (!label) throw new QuotaAdapterError("invalid-config");
      field.label = label;
    }
    for (const key of ["labelPath", "remainingPercentPath", "usedPercentPath", "remainingCountPath", "nextResetTimePath", "remainingAmountPath", "currencyPath", "grantedAmountPath", "toppedUpAmountPath"] as const) {
      if (raw[key] !== undefined) {
        const pointer = readPointer(raw[key]);
        if (pointer === null || pointer === "") throw new QuotaAdapterError("invalid-config");
        field[key] = pointer;
      }
    }
    let metrics: QuotaMetricMapping[] | undefined;
    if (raw.metrics !== undefined) {
      if (!Array.isArray(raw.metrics) || raw.metrics.length < 1 || raw.metrics.length > 20) throw new QuotaAdapterError("invalid-config");
      metrics = raw.metrics.map((rawMetric): QuotaMetricMapping => {
        if (!isRecord(rawMetric)) throw new QuotaAdapterError("invalid-config");
        const label = readShortText(rawMetric.label, 80);
        const valuePath = rawMetric.valuePath === undefined ? undefined : readPointer(rawMetric.valuePath);
        const valueDivisor = rawMetric.valueDivisor;
        let calculation: QuotaMetricCalculation | undefined;
        if (rawMetric.calculation !== undefined) {
          if (!isRecord(rawMetric.calculation)) throw new QuotaAdapterError("invalid-config");
          const operation = rawMetric.calculation.operation;
          const pathsValue = rawMetric.calculation.paths;
          const divisor = rawMetric.calculation.divisor;
          if (!(["sum", "subtract", "multiply", "divide", "min", "max"] as unknown[]).includes(operation)
            || !Array.isArray(pathsValue) || pathsValue.length < 2 || pathsValue.length > 20
            || (operation === "subtract" || operation === "divide") && pathsValue.length !== 2
            || pathsValue.some(path => {
              const pointer = readPointer(path);
              return !pointer || pointer === "";
            })
            || divisor !== undefined && (typeof divisor !== "number" || !Number.isFinite(divisor) || divisor <= 0 || divisor > 1e12)) {
            throw new QuotaAdapterError("invalid-config");
          }
          calculation = {
            operation: operation as QuotaMetricOperation,
            paths: pathsValue as string[],
            ...(divisor !== undefined ? { divisor } : {}),
          };
        }
        const format = rawMetric.format === undefined ? "number" : rawMetric.format;
        const currency = rawMetric.currency === undefined ? undefined : readShortText(rawMetric.currency, 3);
        const currencyPath = rawMetric.currencyPath === undefined ? undefined : readPointer(rawMetric.currencyPath);
        const unit = rawMetric.unit === undefined ? undefined : readShortText(rawMetric.unit, 24);
        const period = rawMetric.period === undefined ? undefined : readShortText(rawMetric.period, 40);
        const periodPath = rawMetric.periodPath === undefined ? undefined : readPointer(rawMetric.periodPath);
        if (!label || (!!valuePath === !!calculation) || valuePath === "" || (format !== "number" && format !== "currency")
          || valueDivisor !== undefined && (typeof valueDivisor !== "number" || !Number.isFinite(valueDivisor) || valueDivisor <= 0 || valueDivisor > 1e12)
          || calculation && valueDivisor !== undefined
          || rawMetric.currency !== undefined && (!currency || !CURRENCY_CODE.test(currency))
          || rawMetric.currencyPath !== undefined && (!currencyPath || currencyPath === "")
          || rawMetric.unit !== undefined && !unit
          || rawMetric.period !== undefined && !period
          || rawMetric.periodPath !== undefined && (!periodPath || periodPath === "")
          || !!period && !!periodPath
          || format === "currency" && (!currency && !currencyPath || !!unit)
          || format === "number" && (!!currency || !!currencyPath)) {
          throw new QuotaAdapterError("invalid-config");
        }
        return {
          label,
          ...(valuePath ? { valuePath } : {}),
          ...(valueDivisor !== undefined ? { valueDivisor } : {}),
          ...(calculation ? { calculation } : {}),
          format: format as QuotaMetricFormat,
          ...(currency ? { currency } : {}),
          ...(currencyPath ? { currencyPath } : {}),
          ...(unit ? { unit } : {}),
          ...(period ? { period } : {}),
          ...(periodPath ? { periodPath } : {}),
        };
      });
    }
    if (raw.currency !== undefined) {
      if (typeof raw.currency !== "string" || !CURRENCY_CODE.test(raw.currency)) throw new QuotaAdapterError("invalid-config");
      field.currency = raw.currency;
    }
    for (const key of ["amountDivisor", "countDivisor"] as const) {
      const divisor = raw[key];
      if (divisor !== undefined && (typeof divisor !== "number" || !Number.isFinite(divisor) || divisor <= 0 || divisor > 1e12)) {
        throw new QuotaAdapterError("invalid-config");
      }
      if (divisor !== undefined) field[key] = divisor;
    }
    if (raw.budgetCalculation !== undefined) {
      if (!isRecord(raw.budgetCalculation)) throw new QuotaAdapterError("invalid-config");
      const limitPath = readPointer(raw.budgetCalculation.limitPath);
      const usedPath = readPointer(raw.budgetCalculation.usedPath);
      const limitDivisor = raw.budgetCalculation.limitDivisor === undefined ? 1 : raw.budgetCalculation.limitDivisor;
      const usedDivisor = raw.budgetCalculation.usedDivisor === undefined ? 1 : raw.budgetCalculation.usedDivisor;
      if (!limitPath || !usedPath || typeof limitDivisor !== "number" || !Number.isFinite(limitDivisor) || limitDivisor <= 0 || limitDivisor > 1e12
        || typeof usedDivisor !== "number" || !Number.isFinite(usedDivisor) || usedDivisor <= 0 || usedDivisor > 1e12) {
        throw new QuotaAdapterError("invalid-config");
      }
      field.budgetCalculation = { limitPath, usedPath, limitDivisor, usedDivisor };
    }
    if (raw.quotaCalculation !== undefined) {
      if (!isRecord(raw.quotaCalculation) || field.budgetCalculation) throw new QuotaAdapterError("invalid-config");
      const limitPath = readPointer(raw.quotaCalculation.limitPath);
      const usedPath = readPointer(raw.quotaCalculation.usedPath);
      const limitDivisor = raw.quotaCalculation.limitDivisor === undefined ? 1 : raw.quotaCalculation.limitDivisor;
      const usedDivisor = raw.quotaCalculation.usedDivisor === undefined ? 1 : raw.quotaCalculation.usedDivisor;
      if (!limitPath || !usedPath || typeof limitDivisor !== "number" || !Number.isFinite(limitDivisor) || limitDivisor <= 0 || limitDivisor > 1e12
        || typeof usedDivisor !== "number" || !Number.isFinite(usedDivisor) || usedDivisor <= 0 || usedDivisor > 1e12) {
        throw new QuotaAdapterError("invalid-config");
      }
      field.quotaCalculation = { limitPath, usedPath, limitDivisor, usedDivisor };
    }
    const resetTimeFormat = raw.resetTimeFormat === undefined ? "auto" : raw.resetTimeFormat;
    if (!["auto", "unix-seconds", "unix-milliseconds", "iso"].includes(String(resetTimeFormat))) throw new QuotaAdapterError("invalid-config");
    field.resetTimeFormat = resetTimeFormat as QuotaResetFormat;
    if (!field.label && !field.labelPath && !displayName) throw new QuotaAdapterError("invalid-config");
    if (metrics) field.metrics = metrics;
    if (!field.remainingPercentPath && !field.usedPercentPath && !field.remainingCountPath && !field.nextResetTimePath && !field.remainingAmountPath
      && !field.budgetCalculation && !field.quotaCalculation && !field.metrics?.length) {
      throw new QuotaAdapterError("invalid-config");
    }
    if (field.budgetCalculation && !field.currency && !field.currencyPath) throw new QuotaAdapterError("invalid-config");
    return field;
  });
  return {
    schemaVersion: 1, id, providerId, displayName, endpoint: endpoint ?? undefined,
    ...(providerTemplateId ? { providerTemplateId } : {}),
    ...(providerBaseURL ? { providerBaseURL } : {}),
    method: method as "GET" | "POST",
    auth: auth as QuotaAdapterAuth,
    apiKeySource: apiKeySource as QuotaAdapterApiKeySource,
    authHeaderName: normalizedAuthHeaderName,
    ...(authHeaderPrefix ? { authHeaderPrefix } : {}),
    requestHeaders,
    ...(body !== undefined ? { body: body as Record<string, unknown> } : {}),
    ...(itemsPath ? { itemsPath } : {}),
    percentScale: percentScale as QuotaPercentScale,
    ...(allowedCurrencies !== undefined ? { allowedCurrencies: allowedCurrencies as string[] } : {}),
    ...(requests ? { requests } : {}),
    fields,
  };
}

export function mapQuotaResponse(response: unknown, rawConfig: unknown): QuotaLine[] {
  const config = validateQuotaAdapter(rawConfig);
  const rowsValue = config.itemsPath ? readPointerValue(response, config.itemsPath) : [response];
  if (!Array.isArray(rowsValue) || rowsValue.length > 100) throw new QuotaAdapterError("mapping-failed");
  const result: QuotaLine[] = [];
  for (const row of rowsValue) {
    for (const field of config.fields) {
      const labelValue = field.labelPath ? readPointerValue(row, field.labelPath) : undefined;
      const label = typeof labelValue === "string" && labelValue.trim()
        ? labelValue.trim().slice(0, 80)
        : field.label ?? config.displayName;
      const budget = field.budgetCalculation ? budgetAt(row, field.budgetCalculation) : null;
      const quotaCalculation = field.quotaCalculation ? quotaAt(row, field.quotaCalculation) : null;
      const remaining = budget?.remainingPercent ?? quotaCalculation?.remainingPercent ?? numericAt(row, field.remainingPercentPath);
      const used = remaining === null ? numericAt(row, field.usedPercentPath) : null;
      const rawPercent = remaining ?? used;
      let remainingPercent: number | undefined;
      let usedPercent: number | undefined;
      if (budget) {
        remainingPercent = budget.remainingPercent;
        usedPercent = 100 - remainingPercent;
      } else if (quotaCalculation) {
        remainingPercent = quotaCalculation.remainingPercent;
        usedPercent = quotaCalculation.usedPercent;
      } else if (rawPercent !== null) {
        const factor = config.percentScale === "0-1" ? 100 : 1;
        const percent = rawPercent * factor;
        if (Number.isFinite(percent) && percent >= 0 && percent <= 100) {
          remainingPercent = remaining !== null ? percent : 100 - percent;
          usedPercent = 100 - remainingPercent;
        }
      }
      const remainingCount = quotaCalculation?.remainingCount ?? scaledNumericAt(row, field.remainingCountPath, field.countDivisor);
      const nextResetTime = resetTimeAt(row, field);
      const remainingAmount = budget?.remainingAmount ?? scaledNumericAt(row, field.remainingAmountPath, field.amountDivisor);
      const currencyValue = field.currencyPath ? readPointerValue(row, field.currencyPath) : field.currency;
      const currency = typeof currencyValue === "string" && CURRENCY_CODE.test(currencyValue.toUpperCase())
        ? currencyValue.toUpperCase()
        : undefined;
      const grantedAmount = scaledNumericAt(row, field.grantedAmountPath, field.amountDivisor);
      const toppedUpAmount = scaledNumericAt(row, field.toppedUpAmountPath, field.amountDivisor);
      const metrics = field.metrics?.flatMap((mapping): QuotaMetric[] => {
        const value = mapping.calculation
          ? calculatedMetricAt(row, mapping.calculation)
          : scaledNumericValueAt(row, mapping.valuePath, mapping.valueDivisor);
        if (value === null) return [];
        const periodValue = mapping.periodPath ? readPointerValue(row, mapping.periodPath) : mapping.period;
        const period = typeof periodValue === "string" ? readShortText(periodValue, 40) ?? undefined : undefined;
        const currencyValue = mapping.currencyPath ? readPointerValue(row, mapping.currencyPath) : mapping.currency;
        const currency = typeof currencyValue === "string" && CURRENCY_CODE.test(currencyValue.toUpperCase())
          ? currencyValue.toUpperCase()
          : undefined;
        if (mapping.format === "currency" && (!currency || config.allowedCurrencies && !config.allowedCurrencies.includes(currency))) return [];
        return [{
          label: mapping.label,
          value,
          format: mapping.format ?? "number",
          ...(currency ? { currency } : {}),
          ...(mapping.unit ? { unit: mapping.unit } : {}),
          ...(period ? { period } : {}),
        }];
      });
      const hasMoney = remainingAmount !== null || grantedAmount !== null || toppedUpAmount !== null;
      if (hasMoney && (!currency || config.allowedCurrencies && !config.allowedCurrencies.includes(currency))) continue;
      const hasValue = remainingPercent !== undefined || remainingCount !== null || nextResetTime !== null || hasMoney || !!metrics?.length;
      if (!hasValue) continue;
      result.push({
        label,
        ...(remainingPercent !== undefined ? { remainingPercent, usedPercent } : {}),
        ...(remainingCount !== null ? { remainingCount } : {}),
        ...(nextResetTime !== null ? { nextResetTime } : {}),
        ...(remainingAmount !== null ? { remainingAmount } : {}),
        ...(hasMoney && currency ? { currency } : {}),
        ...(grantedAmount !== null ? { grantedAmount } : {}),
        ...(toppedUpAmount !== null ? { toppedUpAmount } : {}),
        ...(metrics?.length ? { metrics } : {}),
      });
    }
  }
  if (result.length === 0) throw new QuotaAdapterError("mapping-failed");
  return result;
}

export async function fetchQuotaAdapter(rawConfig: unknown, apiKey?: string, providerBaseURL?: string): Promise<QuotaLine[]> {
  const config = validateQuotaAdapter(rawConfig);
  const secret = apiKey?.trim();
  if (config.auth !== "none" && !secret) throw new QuotaAdapterError("missing-secret");
  if (config.apiKeySource === "zcode" && (!providerBaseURL || !quotaEndpointsMatchProvider(config, providerBaseURL))) {
    throw new QuotaAdapterError("untrusted-provider-origin");
  }
  let response: unknown;
  try {
    if (config.requests) {
      const values = await Promise.all(config.requests.map(async request => [request.id, await requestJson(
        safeEndpoint(request.endpoint, config.auth!),
        request.method ?? config.method!,
        ...buildRequest(config, request, secret)
      )] as const));
      response = Object.fromEntries(values);
    } else {
      const url = safeEndpoint(config.endpoint!, config.auth!);
      response = await requestJson(url, config.method!, ...buildRequest(config, config, secret));
    }
  } catch {
    throw new QuotaAdapterError("request-failed");
  }
  return mapQuotaResponse(response, config);
}

/** Bind reused ZCode credentials to the exact configured provider host. */
export function quotaEndpointsMatchProvider(rawConfig: unknown, providerBaseURL: string): boolean {
  try {
    const config = validateQuotaAdapter(rawConfig);
    const base = new URL(providerBaseURL);
    if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash) return false;
    const endpoints = config.requests?.map(request => request.endpoint) ?? (config.endpoint ? [config.endpoint] : []);
    return endpoints.length > 0 && endpoints.every(endpoint => {
      const target = safeEndpoint(endpoint, config.auth!);
      if (target.protocol !== "https:" || target.hostname.toLowerCase() !== base.hostname.toLowerCase()) return false;
      // Permit the common HTTP-to-HTTPS upgrade (default port 80 to 443), but
      // preserve any explicitly configured non-default provider port.
      const providerHasCustomPort = Boolean(base.port) && !(
        base.protocol === "http:" && base.port === "80" || base.protocol === "https:" && base.port === "443"
      );
      return providerHasCustomPort ? target.port === base.port : target.port === "";
    });
  } catch {
    return false;
  }
}

function parseRequests(
  raw: unknown,
  endpoint: string | undefined,
  defaultMethod: "GET" | "POST",
  auth: QuotaAdapterAuth,
  authHeaderName: string
): QuotaAdapterRequest[] | undefined {
  if (raw === undefined) {
    if (!endpoint) throw new QuotaAdapterError("invalid-config");
    validateSafeUrl(endpoint, auth);
    return undefined;
  }
  if (endpoint || !Array.isArray(raw) || raw.length < 1 || raw.length > 5) throw new QuotaAdapterError("invalid-config");
  const seen = new Set<string>();
  let origin: string | undefined;
  const parsed = raw.map((item): QuotaAdapterRequest => {
    if (!isRecord(item)) throw new QuotaAdapterError("invalid-config");
    const id = readShortText(item.id, 64);
    const requestEndpoint = readShortText(item.endpoint, 2048);
    const method = item.method === undefined ? defaultMethod : item.method;
    if (!id || !SAFE_ID.test(id) || ["__proto__", "prototype", "constructor"].includes(id) || seen.has(id) || !requestEndpoint || method !== "GET" && method !== "POST") {
      throw new QuotaAdapterError("invalid-config");
    }
    seen.add(id);
    const url = validateSafeUrl(requestEndpoint, auth);
    if (origin !== undefined && url.origin !== origin) throw new QuotaAdapterError("invalid-config");
    origin = url.origin;
    const requestHeaders = validateRequestHeaders(item.requestHeaders, auth, authHeaderName);
    const body = item.body;
    if (body !== undefined && (method !== "POST" || !isRecord(body) || safeJson(body).length > MAX_REQUEST_BYTES)) {
      throw new QuotaAdapterError("invalid-config");
    }
    return { id, endpoint: requestEndpoint, method, requestHeaders, ...(body !== undefined ? { body } : {}) };
  });
  return parsed;
}

function validateSafeUrl(endpoint: string, auth: QuotaAdapterAuth): URL {
  const url = safeEndpoint(endpoint, auth);
  if (url.searchParams.size > 0 && [...url.searchParams.keys()].some(key => /(key|token|secret|auth|password)/i.test(key))) {
    throw new QuotaAdapterError("invalid-config");
  }
  return url;
}

function validateRequestHeaders(value: unknown, auth: QuotaAdapterAuth, authHeaderName: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (value === undefined) return headers;
  if (!isRecord(value) || Object.keys(value).length > 30) throw new QuotaAdapterError("invalid-config");
  for (const [name, rawValue] of Object.entries(value)) {
    const lowerName = name.toLowerCase();
    if (!HEADER_NAME.test(name) || FORBIDDEN_HEADERS.has(lowerName) || /(?:api.?key|access.?token|secret|password|credential)/i.test(name)
      || typeof rawValue !== "string" || rawValue.length > 1000 || /[\r\n]/.test(rawValue)
      || auth === "header" && lowerName === authHeaderName.toLowerCase()) {
      throw new QuotaAdapterError("invalid-config");
    }
    headers[name] = rawValue;
  }
  return headers;
}

function buildRequest(
  config: QuotaAdapterConfig,
  source: { method?: "GET" | "POST"; requestHeaders?: Record<string, string>; body?: Record<string, unknown> },
  secret?: string
): [Record<string, string>, string | undefined] {
  const headers: Record<string, string> = { ...config.requestHeaders, ...source.requestHeaders };
  if (config.auth === "bearer") headers.Authorization = `Bearer ${secret}`;
  else if (config.auth === "header") headers[config.authHeaderName!] = `${config.authHeaderPrefix ?? ""}${secret!}`;
  if ((source.method ?? config.method) !== "POST") return [headers, undefined];
  const serialized = source.body ? safeJson(source.body) : "{}";
  headers["Content-Type"] ??= "application/json";
  headers["Content-Length"] = String(Buffer.byteLength(serialized));
  return [headers, serialized];
}

function budgetAt(row: unknown, mapping: NonNullable<QuotaFieldMapping["budgetCalculation"]>): { remainingAmount: number; remainingPercent: number } | null {
  const limit = scaledNumericAt(row, mapping.limitPath, mapping.limitDivisor);
  const rawUsed = numericAt(row, mapping.usedPath);
  if (limit === null || rawUsed === null) return null;
  const used = rawUsed / (mapping.usedDivisor ?? 1);
  if (!Number.isFinite(used)) return null;
  const remainingAmount = Math.max(0, limit - used);
  const remainingPercent = limit > 0 ? Math.max(0, Math.min(100, remainingAmount / limit * 100)) : 0;
  return { remainingAmount, remainingPercent };
}

function quotaAt(row: unknown, mapping: QuotaLimitCalculation): { remainingCount: number; remainingPercent: number; usedPercent: number } | null {
  const limit = scaledNumericAt(row, mapping.limitPath, mapping.limitDivisor);
  const used = scaledNumericAt(row, mapping.usedPath, mapping.usedDivisor);
  if (limit === null || used === null) return null;
  const remainingCount = Math.max(0, limit - used);
  const remainingPercent = limit > 0 ? Math.max(0, Math.min(100, remainingCount / limit * 100)) : 0;
  return { remainingCount, remainingPercent, usedPercent: 100 - remainingPercent };
}

function requestJson(url: URL, method: "GET" | "POST", headers: Record<string, string>, body?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, { method, headers, timeout: 10_000 }, response => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new QuotaAdapterError("request-failed"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy();
          reject(new QuotaAdapterError("bad-response"));
          return;
        }
        chunks.push(bytes);
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        } catch {
          reject(new QuotaAdapterError("bad-response"));
        }
      });
      response.on("error", () => reject(new QuotaAdapterError("request-failed")));
    });
    request.on("timeout", () => request.destroy(new QuotaAdapterError("request-failed")));
    request.on("error", () => reject(new QuotaAdapterError("request-failed")));
    request.end(body);
  });
}

function safeEndpoint(value: string, auth: QuotaAdapterAuth): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new QuotaAdapterError("invalid-config"); }
  if (url.username || url.password || url.hash) throw new QuotaAdapterError("invalid-config");
  if (url.protocol !== "https:") {
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
    if (url.protocol !== "http:" || !local || auth !== "none") throw new QuotaAdapterError("invalid-config");
  }
  return url;
}

function numericAt(row: unknown, pointer?: string): number | null {
  if (!pointer) return null;
  const value = readPointerValue(row, pointer);
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function scaledNumericAt(row: unknown, pointer?: string, divisor = 1): number | null {
  const value = numericAt(row, pointer);
  return value === null ? null : value / divisor;
}

function numericValueAt(row: unknown, pointer?: string): number | null {
  if (!pointer) return null;
  const value = readPointerValue(row, pointer);
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function scaledNumericValueAt(row: unknown, pointer?: string, divisor = 1): number | null {
  const value = numericValueAt(row, pointer);
  return value === null ? null : value / divisor;
}

function calculatedMetricAt(row: unknown, calculation: QuotaMetricCalculation): number | null {
  const values = calculation.paths.map(pointer => numericValueAt(row, pointer));
  if (values.some(value => value === null)) return null;
  const numbers = values as number[];
  let result: number;
  switch (calculation.operation) {
    case "sum": result = numbers.reduce((sum, value) => sum + value, 0); break;
    case "subtract": result = numbers[0] - numbers[1]; break;
    case "multiply": result = numbers.reduce((product, value) => product * value, 1); break;
    case "divide":
      if (numbers[1] === 0) return null;
      result = numbers[0] / numbers[1];
      break;
    case "min": result = Math.min(...numbers); break;
    case "max": result = Math.max(...numbers); break;
  }
  result /= calculation.divisor ?? 1;
  return Number.isFinite(result) ? result : null;
}

function resetTimeAt(row: unknown, field: QuotaFieldMapping): number | null {
  if (!field.nextResetTimePath) return null;
  const value = readPointerValue(row, field.nextResetTimePath);
  if (typeof value === "string" && field.resetTimeFormat !== "unix-seconds" && field.resetTimeFormat !== "unix-milliseconds") {
    const date = Date.parse(value);
    return Number.isFinite(date) && date > 0 && date <= 8.64e15 ? date : null;
  }
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const milliseconds = field.resetTimeFormat === "unix-seconds" || field.resetTimeFormat === "auto" && numeric < 1e12;
  const normalized = milliseconds ? numeric * 1000 : numeric;
  return Number.isFinite(normalized) && normalized <= 8.64e15 ? normalized : null;
}

function readPointer(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500 || (value !== "" && !value.startsWith("/"))) return null;
  if (/~(?![01])/.test(value)) return null;
  if (value.split("/").some(part => ["__proto__", "prototype", "constructor"].includes(part.replace(/~1/g, "/").replace(/~0/g, "~")))) return null;
  return value;
}

function readPointerValue(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  let current = value;
  for (const part of pointer.slice(1).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function readShortText(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= maxLength && !/[\r\n\0]/.test(value)
    ? value.trim()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { throw new QuotaAdapterError("invalid-config"); }
}
