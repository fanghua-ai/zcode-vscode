import assert from "node:assert/strict";
import test from "node:test";
import { SendTiming } from "./sendTiming";

test("send diagnostics measure admission, first output and frame acknowledgement without identities", () => {
  const logs: Array<Record<string, string | number | boolean>> = [];
  const timing = new SendTiming(data => logs.push(data));
  timing.start("private-session", "private-probe", Date.now());
  timing.mark("private-probe", "promptPreparedMs");
  timing.running("private-session");
  timing.admitted("private-probe");
  assert.equal(timing.firstOutput("private-session"), "private-probe");
  assert.equal(timing.firstOutput("private-session"), undefined);
  timing.visible("private-session", "private-probe", 24);
  assert.deepEqual(logs.map(data => data.stage), ["admitted", "first_output", "paint_ack"]);
  assert.equal(logs.at(-1)?.webviewFrameWaitMs, 24);
  assert.ok("firstOutputPostedMs" in logs[1]);
  assert.ok("runningStatusPostedMs" in logs[1]);
  assert.ok(!JSON.stringify(logs).includes("private-"));
  timing.clear();
});

test("late diagnostics cannot cross sessions or replacement sends", () => {
  const logs: Array<Record<string, string | number | boolean>> = [];
  const timing = new SendTiming(data => logs.push(data));
  timing.start("A", "old");
  timing.start("B", "new");
  assert.equal(timing.firstOutput("A"), undefined);
  timing.admitted("old");
  timing.end("rejected", "old");
  assert.equal(logs.length, 0);
  assert.equal(timing.firstOutput("B"), "new");
  timing.visible("A", "new", 20);
  timing.visible("B", "old", 20);
  for (const bad of [NaN, Infinity, -1, 180001, "20"]) timing.visible("B", "new", bad);
  assert.equal(logs.length, 1);
  timing.visible("B", "new", 20);
  timing.admitted("new");
  assert.equal(logs.length, 3);
  timing.clear();
});

test("first output can precede command admission and stopped probes reject late frames", () => {
  const logs: Array<Record<string, string | number | boolean>> = [];
  const timing = new SendTiming(data => logs.push(data));
  timing.start("A", "probe");
  assert.equal(timing.firstOutput("A"), "probe");
  timing.visible("A", "probe", 16);
  timing.admitted("probe");
  assert.deepEqual(logs.map(data => data.stage), ["first_output", "paint_ack", "admitted"]);
  timing.start("A", "stopped");
  timing.endForSession("B", "interrupted");
  timing.endForSession("A", "interrupted");
  assert.equal(timing.firstOutput("A"), undefined);
  timing.visible("A", "stopped", 16);
  assert.equal(logs.at(-1)?.stage, "interrupted");
  timing.clear();
});
