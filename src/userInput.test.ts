import assert from "node:assert/strict";
import test from "node:test";
import { QuestionAnswers } from "./userInput";

test("multi-select preserves multiple choices and permits deselection before submission", () => {
  const answers = new QuestionAnswers([
    { question: "Features", multiSelect: true, options: [{ value: 'say "hello"' }, { value: "B" }] },
    { question: "Mode", options: [{ value: "fast" }, { value: "slow" }] },
  ]);
  answers.toggle(0, 'say "hello"');
  answers.toggle(0, "B");
  assert.equal(answers.complete(), false);
  answers.toggle(1, "fast");
  answers.toggle(1, "slow");
  assert.equal(answers.complete(), true);
  assert.deepEqual(answers.content(), { answers: { Features: 'say "hello", B', Mode: "slow" } });
  answers.toggle(0, "B");
  assert.equal(answers.selected(0, "B"), false);
  answers.toggle(0, 'say "hello"');
  assert.equal(answers.complete(), false);
});

test("single answers retain the existing wire shape and reject unknown options", () => {
  const answers = new QuestionAnswers([{ question: "Mode", options: [{ value: "fast" }] }]);
  answers.toggle(0, "unknown");
  assert.equal(answers.complete(), false);
  answers.toggle(0, "fast");
  assert.deepEqual(answers.content(), { answer: "fast", answers: { Mode: "fast" } });
});
