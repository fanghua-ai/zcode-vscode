import * as vscode from "vscode";
import { redactDiagnosticText } from "./diagnostics";

let channel: vscode.LogOutputChannel | undefined;
// Set by disposeLog so late writes (a process exit callback after deactivate) cannot recreate the channel.
let closed = false;
const MAX_LOG_CHARS = 512 * 1024;
const MAX_LOG_ENTRIES = 1000;
const recent: Array<{ prefix: string; parts: string[]; size: number }> = [];
let recentSize = 0;

/** Explicit callers only (activate, show log); this reopens the channel after a dispose. */
export function getLog(): vscode.LogOutputChannel {
  closed = false;
  if (!channel) {
    channel = vscode.window.createOutputChannel("ZCode", { log: true });
  }
  return channel;
}

/** Registered in context.subscriptions so the channel is released when the extension deactivates. */
export function disposeLog(): void {
  closed = true;
  channel?.dispose();
  channel = undefined;
  recent.length = 0;
  recentSize = 0;
}

export function logInfo(message: string, ...rest: unknown[]): void {
  write("info", message, rest);
}

export function logWarn(message: string, ...rest: unknown[]): void {
  write("warn", message, rest);
}

export function logError(message: string, ...rest: unknown[]): void {
  write("error", message, rest);
}

export function logDebug(message: string, ...rest: unknown[]): void {
  write("debug", message, rest);
}

function write(level: "info" | "warn" | "error" | "debug", message: string, rest: unknown[]): void {
  if (closed) return;
  const parts = [message, ...rest.map(stringify)];
  const text = parts.join(" ");
  getLog()[level](text);
  const prefix = `${new Date().toISOString()} [${level}] `;
  const size = prefix.length + text.length + 1;
  // Keep complete entries so a truncated credential cannot lose its field name.
  if (size > MAX_LOG_CHARS) return;
  recent.push({ prefix, parts, size });
  recentSize += size;
  while (recent.length > MAX_LOG_ENTRIES || recentSize > MAX_LOG_CHARS) {
    recentSize -= recent.shift()!.size;
  }
}

export function readRedactedLog(home: string): string {
  return recent.map(({ prefix, parts }) =>
    prefix + redactDiagnosticText(parts.map(part => redactDiagnosticText(part, home)).join(" "), home)
  ).join("\n");
}

function stringify(v: unknown): string {
  if (v instanceof Error) return v.stack ?? v.message;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
