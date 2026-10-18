import * as fs from "fs";
import * as path from "path";
import { logDebug, logWarn } from "./log";

/** Desktop files may briefly disappear, be locked, or contain partial JSON during a save. */
export function readDesktopJson<T>(file: string): T {
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("Desktop JSON must be an object");
  return value as T;
}

export async function readDesktopJsonWithRetry<T>(file: string): Promise<T> {
  const delays = [80, 160, 320];
  for (let attempt = 0; ; attempt++) {
    try {
      const value = readDesktopJson<T>(file);
      if (attempt) logDebug("Desktop JSON read recovered", { file: path.basename(file), attempts: attempt + 1 });
      return value;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = error instanceof SyntaxError || ["ENOENT", "EBUSY", "EPERM", "EACCES"].includes(code ?? "");
      if (!transient || attempt >= delays.length) {
        // Never log a JSON parse message: it can quote the credential contents.
        if (code !== "ENOENT") logWarn("Desktop JSON read failed", { file: path.basename(file), code: code ?? (error as Error).name, attempts: attempt + 1 });
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
}
