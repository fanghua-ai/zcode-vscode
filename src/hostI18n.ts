import * as vscode from "vscode";
import { resolveUiLanguage, translate, LocalizedError } from "./i18n";

/** Host and webview have separate module state; read the preference on each call. */
export function hostT(key: string, values?: Record<string, unknown>): string {
  const setting = vscode.workspace.getConfiguration("zcode").get<string>("language", "auto");
  return translate(key, resolveUiLanguage(setting, vscode.env.language), values);
}

export function userFacingError(error: unknown): string {
  if (error instanceof LocalizedError) return hostT(error.key, error.values);
  let message = error instanceof Error ? error.message : String(error);
  message = message.replace(/^ZCode error -?\d+:\s*/, "");
  return hostT(message);
}
