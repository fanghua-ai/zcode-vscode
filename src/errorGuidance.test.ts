import assert from "node:assert/strict";
import test from "node:test";
import { errorGuidance, COMMUNITY_URL } from "./errorGuidance";
import { translate } from "./i18n";
import { traditionalMessages } from "./i18n.zhTW";
const cases: Array<[string,string,string]> = [
  ["已设置的 zcode.binaryPath 不存在：D:\\Custom\\zcode.cjs","installation","binaryPath"],
  ["Cannot find module '/custom/zcode.cjs'\nNode.js v24","installation","binaryPath"],
  ["spawn node ENOENT","runtime","nodePath"],
  ["No available model","model","pickModel"],
  ["provider.notInRegistry","model","pickModel"],
  ["ZCode error -32031: 模型已不可用","model","pickModel"],
  ["401 Unauthorized","login","retry"],
  ["余额不足 1113","quota","retry"],
  ["Method not found","compatibility","retry"],
  ["ECONNRESET","network","retry"],
  ["ZCode process exited","network","retry"],
  ["EPERM: permission denied","access","retry"],
  ["Unexpected failure: <script>中文原始诊断</script>","general","pickModel"],
];
test("common diagnostics map to actionable recovery instead of log-only errors",()=>{
  for(const [source,category,action] of cases){const guidance=errorGuidance(source);assert.equal(guidance.category,category,source);assert.equal(guidance.action,action);assert.ok(guidance.hint.length);}
  assert.match(errorGuidance(cases[0][0]).hint,/zcode\.binaryPath.*resources\/glm\/zcode\.cjs/);
  assert.match(errorGuidance("No available model").hint,/重新选择.*重试/);
});
test("all recovery labels and instructions are translated without translating diagnostics",()=>{
  for(const [source] of cases){const guidance=errorGuidance(source);for(const key of [guidance.title,guidance.hint,guidance.label]){
    assert.doesNotMatch(translate(key,"en"),/[\u4e00-\u9fff]/);
    assert.ok(traditionalMessages[key],key);
  }}
  assert.equal(new URL(COMMUNITY_URL).hostname,"marketplace.visualstudio.com");
});
