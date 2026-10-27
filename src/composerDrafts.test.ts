import assert from "node:assert/strict";
import test from "node:test";
import { ComposerDrafts } from "./composerDrafts";
const chip = { path: "/project/a.ts", relPath: "a.ts", selectedText: "original selection" };
const sessionRef = { sessionId: "sess_1234-abcd", title: "Background conversation" };

test("drafts and explicit selections survive reload and stay session scoped", () => {
  const drafts = new ComposerDrafts(undefined);
  drafts.set("A", "A draft", [chip]);
  drafts.set("B", "B draft", []);
  const restored = new ComposerDrafts(JSON.parse(JSON.stringify(drafts.serialize())));
  assert.deepEqual(restored.get("A"), { text: "A draft", chips: [{ ...chip, implicit: false }] });
  assert.deepEqual(restored.get("B"), { text: "B draft", chips: [] });
  restored.get("A").chips[0].selectedText = "modified";
  assert.equal(restored.get("A").chips[0].selectedText, "original selection");
});
test("cleared sent text cannot reappear on reload; explicit references remain pinned", () => {
  const drafts = new ComposerDrafts(undefined);
  drafts.set("A", "sent", [chip]);
  drafts.set("A", "", [chip]);
  const restored = new ComposerDrafts(drafts.serialize());
  assert.equal(restored.get("A").text, "");
  assert.equal(restored.get("A").chips.length, 1);
});
test("rejection preserves later typing and references without affecting another session", () => {
  const drafts = new ComposerDrafts(undefined);
  drafts.set("A", "new typing", [chip]);
  drafts.set("B", "B draft", []);
  assert.equal(drafts.recover("A", { text: "failed send", chips: [chip] }).text, "new typing\n\nfailed send");
  assert.equal(drafts.get("A").chips.length, 1);
  assert.equal(drafts.get("B").text, "B draft");
});
test("typing before session readiness joins the destination draft without losing either", () => {
  const drafts = new ComposerDrafts(undefined);
  drafts.set("B", "saved B", []);
  drafts.set("", "typed during switch", [chip]);
  assert.equal(drafts.takePending("B").text, "saved B\n\ntyped during switch");
  assert.equal(drafts.get("").text, "");
  assert.equal(drafts.takePending("B").text, "saved B\n\ntyped during switch");
});
test("corrupt state is ignored and implicit editor context is never persisted", () => {
  const drafts = new ComposerDrafts({ A: { text: 123, chips: [] }, B: { text: "B", chips: [null, { path: 1 }] } });
  drafts.set("C", "C", [{ ...chip, implicit: true }]);
  assert.equal(drafts.get("A").text, "");
  assert.equal(drafts.get("B").chips.length, 0);
  assert.equal(drafts.get("C").chips.length, 0);
});

test("conversation references survive reload and failed-send recovery without crossing drafts", () => {
  const drafts = new ComposerDrafts(undefined);
  drafts.set("A", "draft A", [chip], [], [sessionRef]);
  drafts.set("B", "draft B", []);
  const restored = new ComposerDrafts(JSON.parse(JSON.stringify(drafts.serialize())));
  assert.deepEqual(restored.get("A").sessionRefs, [sessionRef]);
  assert.deepEqual(restored.get("B").sessionRefs, undefined);
  const recovered = restored.recover("A", { text: "failed", chips: [], sessionRefs: [sessionRef] });
  assert.equal(recovered.text, "draft A\n\nfailed");
  assert.deepEqual(recovered.sessionRefs, [sessionRef]);
  assert.equal(restored.get("B").text, "draft B");
});

test("multiple skill selections survive reload, handoff and failed-send recovery", () => {
  const first = { name: "alpha", path: "/skills/one/SKILL.md" };
  const second = { name: "beta", path: "C:\\My Skills\\two\\SKILL.md" };
  const drafts = new ComposerDrafts(undefined);
  drafts.set("A", "question", [], [], [], [first, second]);
  const restored = new ComposerDrafts(JSON.parse(JSON.stringify(drafts.serialize())));
  assert.deepEqual(restored.get("A").skills, [first, second]);
  restored.set("", "pending", [], [], [], [first]);
  assert.deepEqual(restored.takePending("A").skills, [first, second]);
  assert.deepEqual(restored.recover("A", { text: "failed", chips: [], skills: [second] }).skills, [first, second]);
  assert.equal(restored.get("B").skills, undefined);
});

test("subagent selections survive draft persistence and failed-send recovery", () => {
  const agents = [{ name: "Explore" }, { name: "demo:reviewer" }];
  const drafts = new ComposerDrafts(undefined);
  drafts.set("A", "question", [], [], [], [], agents);
  const restored = new ComposerDrafts(JSON.parse(JSON.stringify(drafts.serialize())));
  assert.deepEqual(restored.recover("A", { text: "retry", chips: [], agents }).agents, agents);
  assert.equal(restored.get("B").agents, undefined);
});
