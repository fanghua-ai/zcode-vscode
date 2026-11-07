import assert from "node:assert/strict";
import test from "node:test";
import * as vscode from "vscode";
// "./log" is stubbed for the other tests; this path loads the real module.
import { disposeLog, getLog, logInfo, logWarn, logError, logDebug, readRedactedLog } from "../src/log";

test("log writes after dispose do not recreate the output channel", () => {
  let created = 0;
  let disposed = 0;
  const window = vscode.window as unknown as { createOutputChannel: () => unknown };
  window.createOutputChannel = () => {
    created++;
    return { info() {}, warn() {}, error() {}, debug() {}, show() {}, dispose() { disposed++; } };
  };
  getLog();
  disposeLog();
  logWarn("app-server exited");
  assert.deepEqual([created, disposed], [1, 1]);
  getLog();
  logWarn("after the next activate");
  assert.equal(created, 2);
});

test("local OutputChannel keeps original credentials, organization and paths at every log level", t => {
  disposeLog();
  const original = vscode.window.createOutputChannel;
  const written: string[] = [];
  vscode.window.createOutputChannel = (() => ({
    info: (text: string) => written.push(text), warn: (text: string) => written.push(text),
    error: (text: string) => written.push(text), debug: (text: string) => written.push(text),
    show() {}, dispose() {},
  })) as unknown as typeof original;
  t.after(() => { disposeLog(); vscode.window.createOutputChannel = original; });
  getLog();
  const details = { apiKey: "TEST-LOCAL-KEY", organizationId: "org-local", path: "/Users/local-user/project" };
  for (const write of [logInfo, logWarn, logError, logDebug]) write("Authorization: Bearer TEST-LOCAL-TOKEN", details);
  assert.equal(written.length, 4);
  for (const text of written) {
    assert.equal(text, `Authorization: Bearer TEST-LOCAL-TOKEN ${JSON.stringify(details)}`);
    assert.doesNotMatch(text, /REDACTED/);
  }
  logWarn("HTTP request failed", { status: 400, apiKey: { nested: "NESTED_CREDENTIAL" }, deviceMid: "PRIVATE_DEVICE", path: details.path });
  logInfo("Cookie: first=PRIVATE_COOKIE; second=ANOTHER_COOKIE");
  logDebug("Authorization:", "Bearer SPLIT_PRIVATE_TOKEN");
  const exported = readRedactedLog("/Users/local-user");
  assert.match(exported, /\[warn\] HTTP request failed .*"status":400/);
  assert.match(exported, /~\/project/);
  assert.match(exported, /\[debug\] Authorization: \[REDACTED\]/);
  assert.doesNotMatch(exported, /TEST-LOCAL|org-local|local-user|NESTED_CREDENTIAL|PRIVATE_DEVICE|PRIVATE_COOKIE|ANOTHER_COOKIE|SPLIT_PRIVATE_TOKEN/);
});
