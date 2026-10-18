import assert from "node:assert/strict";
import test from "node:test";
import { greetingKey, nextGreetingDelay } from "./greeting";

test("new-chat greetings match desktop period boundaries on the local clock", () => {
  const expected: Record<number, string> = {
    0: "夜深啦，别忘了照顾好自己哦", 4: "夜深啦，别忘了照顾好自己哦",
    5: "早上好呀，新的一天开始啦", 8: "早上好呀，新的一天开始啦",
    9: "上午好呀，有什么想让我帮忙的吗", 11: "上午好呀，有什么想让我帮忙的吗",
    12: "中午好呀，要不要先休息一下", 13: "中午好呀，要不要先休息一下",
    14: "下午好呀，接下来交给我吧", 17: "下午好呀，接下来交给我吧",
    18: "晚上好呀，今天辛苦啦", 22: "晚上好呀，今天辛苦啦",
    23: "夜深啦，别忘了照顾好自己哦",
  };
  for (const [hour, key] of Object.entries(expected)) {
    assert.equal(greetingKey(new Date(2026, 9, 2, Number(hour))), key);
  }
});

test("greeting refresh occurs at the next boundary rather than a polling interval", () => {
  assert.equal(nextGreetingDelay(new Date(2026, 9, 2, 17, 59, 59, 999)), 1);
  assert.equal(nextGreetingDelay(new Date(2026, 9, 2, 18)), 5 * 60 * 60 * 1000);
  assert.equal(nextGreetingDelay(new Date(2026, 9, 2, 8, 30)), 30 * 60 * 1000);
});

test("late-night greeting refresh crosses midnight to the next local morning", () => {
  const now = new Date(2026, 9, 2, 23, 59, 59);
  const next = new Date(now.getTime() + nextGreetingDelay(now));
  assert.equal(next.getDate(), 3);
  assert.equal(next.getHours(), 5);
  assert.equal(next.getMinutes(), 0);
});
