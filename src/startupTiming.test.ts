import assert from "node:assert/strict";
import test from "node:test";
import { StartupTiming } from "./startupTiming";

test("startup timing sums repeated phases and keeps counts", () => {
  const timing = new StartupTiming("open");
  timing.add("session/list", 20);
  timing.add("session/list", 5);
  timing.set("spawnToFirstRpc", 40);
  timing.note("loginNetwork", false);
  timing.note("sessionRuntimeState", "cold");
  timing.addCount("historyPosts");
  timing.addCount("historyPosts");
  timing.mark("historyPostedMs");
  const firstPosted = timing.snapshot().historyPostedMs;
  timing.mark("historyPostedMs");
  assert.equal(timing.snapshot().historyPostedMs, firstPosted);
  const snap = timing.snapshot();
  assert.equal(snap.kind, "open");
  assert.equal(snap["session/list"], 25);
  assert.equal(snap.spawnToFirstRpc, 40);
  assert.equal(snap.loginNetwork, false);
  assert.equal(snap.sessionRuntimeState, "cold");
  assert.equal(snap.historyPosts, 2);
  assert.equal(typeof snap.totalMs, "number");
});

test("host timing distinguishes event-loop blocking and stops its monitor after delivery", async () => {
  const timing = new StartupTiming("open", true);
  try {
    await new Promise(resolve => setTimeout(resolve, 45));
    const stop = performance.now() + 65;
    while (performance.now() < stop) { /* Simulate a synchronous extension activation. */ }
    await new Promise(resolve => setTimeout(resolve, 45));
    timing.dispose();
    const measured = timing.snapshot();
    assert.ok(Number(measured.hostEventLoopDelayMaxMs) >= 55);
    assert.ok(Number(measured.hostEventLoopActiveMs) >= 50);
    await new Promise(resolve => setTimeout(resolve, 25));
    timing.dispose();
    assert.equal(timing.snapshot().hostEventLoopDelayMaxMs, measured.hostEventLoopDelayMaxMs);
    assert.equal(timing.snapshot().hostEventLoopActiveMs, measured.hostEventLoopActiveMs);
    assert.equal(new StartupTiming("switch").snapshot().hostEventLoopDelayMaxMs, undefined);
  } finally { timing.dispose(); }
});

test("zero Electron utilization counters are unavailable rather than an idle host", async () => {
  const { performance: hostPerformance } = await import("node:perf_hooks");
  const original = hostPerformance.eventLoopUtilization;
  hostPerformance.eventLoopUtilization = () => ({active:0,idle:0,utilization:0});
  const timing = new StartupTiming("open", true);
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    timing.dispose();
    const measured = timing.snapshot();
    assert.equal(measured.hostEventLoopUtilizationAvailable, false);
    assert.equal(measured.hostEventLoopActiveMs, undefined);
    assert.equal(measured.hostEventLoopIdleMs, undefined);
    assert.equal(typeof measured.hostEventLoopDelayMaxMs, "number");
  } finally { timing.dispose(); hostPerformance.eventLoopUtilization = original; }
});
