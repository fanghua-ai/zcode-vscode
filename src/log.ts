import * as vscode from "vscode";

let channel: vscode.LogOutputChannel | undefined;

export function getLog(): vscode.LogOutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("ZCode", { log: true });
  }
  return channel;
}

export function logInfo(message: string, ...rest: unknown[]): void {
  getLog().info(format(message, rest));
}

export function logWarn(message: string, ...rest: unknown[]): void {
  getLog().warn(format(message, rest));
}

export function logError(message: string, ...rest: unknown[]): void {
  getLog().error(format(message, rest));
}

export function logDebug(message: string, ...rest: unknown[]): void {
  getLog().debug(format(message, rest));
}

function format(message: string, rest: unknown[]): string {
  if (rest.length === 0) return message;
  return `${message} ${rest.map((v) => stringify(v)).join(" ")}`;
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
