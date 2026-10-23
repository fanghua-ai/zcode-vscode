import * as vscode from "vscode";
import { redactSecrets } from "./redact";

let channel: vscode.LogOutputChannel | undefined;
// Set by disposeLog so late writes (a process exit callback after deactivate) cannot recreate the channel.
let closed = false;

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
}

export function logInfo(message: string, ...rest: unknown[]): void {
  if (!closed) getLog().info(format(message, rest));
}

export function logWarn(message: string, ...rest: unknown[]): void {
  if (!closed) getLog().warn(format(message, rest));
}

export function logError(message: string, ...rest: unknown[]): void {
  if (!closed) getLog().error(format(message, rest));
}

export function logDebug(message: string, ...rest: unknown[]): void {
  if (!closed) getLog().debug(format(message, rest));
}

function format(message: string, rest: unknown[]): string {
  const text = rest.length === 0 ? message : `${message} ${rest.map((v) => stringify(v)).join(" ")}`;
  return redactSecrets(text);
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
