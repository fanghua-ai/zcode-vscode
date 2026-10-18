import type { ClientRequest, IncomingMessage } from "http";

/** End every JSON request, including a response aborted after its headers arrived. */
export function readJsonRequest(
  start: (receive: (response: IncomingMessage) => void) => ClientRequest,
  timeoutMs = 15000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) {
        reject(error);
        response?.destroy?.();
        request?.destroy();
      } else resolve(value);
    };
    const interrupted = () => finish(Object.assign(new Error("JSON response interrupted"), { code: "ECONNRESET" }));
    // A socket inactivity timeout alone cannot bound a dripping response or a
    // response whose socket has already closed. Keep a whole-request deadline.
    const deadline = setTimeout(() => finish(Object.assign(new Error("JSON request timed out"), { code: "ETIMEDOUT" })), timeoutMs);
    try {
      request = start(res => {
        response = res;
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("error", error => finish(error));
        res.on("aborted", interrupted);
        res.on("close", () => { if (!res.complete) interrupted(); });
        res.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += data.length;
          if (bytes > 8 * 1024 * 1024) { finish(new Error("JSON response is too large")); return; }
          chunks.push(data);
        });
        res.on("end", () => {
          if (settled) return;
          if (res.complete === false) { interrupted(); return; }
          try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { finish(new Error("Failed to parse JSON response")); }
        });
      });
      request.on("error", error => finish(error));
      if (settled) request.destroy();
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
