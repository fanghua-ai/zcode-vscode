import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNewSessionDefaults, sameSessionModel } from "./newSessionDefaults";

test("new-session defaults only retain supported preference shapes", () => {
  assert.deepEqual(normalizeNewSessionDefaults({
    model: { providerId: " provider ", modelId: " model " },
    mode: "plan",
    thoughtLevel: " high ",
  }), {
    model: { providerId: "provider", modelId: "model" },
    mode: "plan",
    thoughtLevel: "high",
  });
  assert.deepEqual(normalizeNewSessionDefaults({
    model: { providerId: "provider", modelId: "" },
    mode: "auto",
    thoughtLevel: "x".repeat(81),
  }), {});
  assert.equal(sameSessionModel({ providerId: "p", modelId: "m" }, { providerId: "p", modelId: "m" }), true);
  assert.equal(sameSessionModel({ providerId: "p", modelId: "m" }, { providerId: "p", modelId: "n" }), false);
});
