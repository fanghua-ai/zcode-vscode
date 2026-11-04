import { redactSecrets } from "./redact";
import * as vscode from "vscode";
import { resolveUiLanguage, translate, LocalizedError } from "./i18n";

/** Host and webview have separate module state; read the preference on each call. */
export function hostT(key: string, values?: Record<string, unknown>): string {
  const setting = vscode.workspace.getConfiguration("zcode").get<string>("language", "auto");
  return translate(key, resolveUiLanguage(setting, vscode.env.language), values);
}

export function userFacingError(error: unknown): string {
  // Both kinds become readable text first, then go through the same redaction: raw errors may echo request
  // headers or stderr, and localized errors interpolate paths, commands or stderr into their template.
  let text: string;
  if (error instanceof LocalizedError) {
    text = hostT(error.key, error.values);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    const rpc = /^ZCode error (-?\d+):\s*/.exec(message);
    text = hostT(rpc ? message.slice(rpc[0].length) : message);
    // Keep protocol failures identifiable after localization; other errors
    // retain the existing readable-message format.
    if (rpc && (rpc[1] === "-32601" || rpc[1] === "-32602")) {
      text = `ZCode error ${rpc[1]}: ${text}`;
    }
  }
  return redactSecrets(text);
}
