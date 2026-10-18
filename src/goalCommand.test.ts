import assert from "node:assert/strict";
import test from "node:test";
import { parseGoalCommand } from "./goalCommand";

test("a goal objective is a set command and the verbs stay verbs", () => {
  assert.deepEqual(parseGoalCommand("/goal 发布 1.5 版本"), {
    kind: "set",
    objective: "发布 1.5 版本",
    displayText: "/goal 发布 1.5 版本",
  });
  assert.deepEqual(parseGoalCommand("  /target replace 改用新的目标  "), {
    kind: "set",
    objective: "改用新的目标",
    displayText: "/target replace 改用新的目标",
  });
  assert.deepEqual(parseGoalCommand("/goal pause"), { kind: "pause" });
  assert.deepEqual(parseGoalCommand("/goal resume"), { kind: "resume" });
  assert.deepEqual(parseGoalCommand("/goal clear"), { kind: "clear" });
  assert.equal(parseGoalCommand("/goal"), null);
  assert.equal(parseGoalCommand("请完成 /goal 这件事"), null);
});
