import assert from "node:assert/strict";
import test from "node:test";
import * as vscode from "vscode";
// "./log" is stubbed for the other tests; this path loads the real module.
import { disposeLog, getLog, logWarn } from "../src/log";

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
