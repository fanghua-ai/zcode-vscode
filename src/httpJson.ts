import type { ClientRequest, IncomingMessage } from "http";

export class JsonRequestError extends Error {
  constructor(readonly code: "HTTP_STATUS" | "INVALID_JSON" | "RESPONSE_TOO_LARGE", readonly status?: number,
    readonly resultCode?: number | string, readonly responseReason?: "device_id" | "app_version" | "invalid_parameters") {
    super(code === "HTTP_STATUS" ? `JSON request failed (HTTP ${status})` : code === "INVALID_JSON" ? "Failed to parse JSON response" : "JSON response is too large");
    this.name = "JsonRequestError";
  }
}

/** End every JSON request, including a response aborted after its headers arrived. */
export function readJsonRequest(
  start: (receive: (response: IncomingMessage) => void) => ClientRequest,
  timeoutMs = 15000,
  onResponse?: (status: number | undefined) => void
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let settled = false;
    let rejectionTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectStatus: (() => void) | undefined;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(rejectionTimer);
      if (error) {
        if (response?.statusCode !== undefined) Object.assign(error, { status: response.statusCode });
        reject(error);
        response?.destroy?.();
        request?.destroy();
      } else resolve(value);
    };
    const interrupted = () => finish(Object.assign(new Error("JSON response interrupted"), { code: "ECONNRESET" }));
    // A socket inactivity timeout alone cannot bound a dripping response or a
    // response whose socket has already closed. Keep a whole-request deadline.
    const deadline = setTimeout(() => {
      if (rejectStatus) rejectStatus();
      else finish(Object.assign(new Error("JSON request timed out"), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    try {
      request = start(res => {
        response = res;
        onResponse?.(res.statusCode);
        const chunks: Buffer[] = [];
        let bytes = 0;
        if (res.statusCode !== undefined && (res.statusCode < 200 || res.statusCode >= 300)) {
          const status = res.statusCode;
          const reject = () => finish(new JsonRequestError("HTTP_STATUS", status));
          rejectStatus = reject;
          rejectionTimer = setTimeout(reject, 300);
          res.on("error", reject);
          res.on("aborted", reject);
          res.on("close", reject);
          res.on("data", (chunk: Buffer | string) => {
            if (settled) return;
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += data.length;
            if (bytes > 8192) return reject();
            chunks.push(data);
          });
          res.on("end", () => {
            if (settled) return;
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              const code: unknown = body?.error?.code ?? body?.code;
              const resultCode = typeof code === "number" && Number.isSafeInteger(code)
                || typeof code === "string" && /^-?\d{1,12}$/.test(code) ? code : undefined;
              const message = body?.error?.message ?? body?.message ?? body?.msg ?? body?.detail;
              const reason = typeof message !== "string" ? undefined
                : /device[-_ ]?mid/i.test(message) ? "device_id"
                : /app[-_ ]?version/i.test(message) ? "app_version"
                : /paramet(?:er|re).*(?:invalid|error)|invalid parameter|参数错误/i.test(message) ? "invalid_parameters" : undefined;
              finish(new JsonRequestError("HTTP_STATUS", status, resultCode, reason));
            } catch { reject(); }
          });
          return;
        }
        res.on("error", error => finish(error));
        res.on("aborted", interrupted);
        res.on("close", () => { if (!res.complete) interrupted(); });
        res.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += data.length;
          if (bytes > 8 * 1024 * 1024) { finish(new JsonRequestError("RESPONSE_TOO_LARGE", res.statusCode)); return; }
          chunks.push(data);
        });
        res.on("end", () => {
          if (settled) return;
          if (res.complete === false) { interrupted(); return; }
          try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { finish(new JsonRequestError("INVALID_JSON", res.statusCode)); }
        });
      });
      request.on("error", error => rejectStatus ? rejectStatus() : finish(error));
      if (settled) request.destroy();
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
