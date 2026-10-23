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
    text = hostT(message.replace(/^ZCode error -?\d+:\s*/, ""));
  }
  return redactSecrets(text);
}
