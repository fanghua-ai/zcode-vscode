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
  ['ZCode error -32602: Unrecognized key: "apiKey"',"compatibility","retry"],
  ['ZCode error -32602: Unrecognized key: "quota"',"compatibility","retry"],
  ['ZCode error -32601: Unknown method login',"compatibility","retry"],
  ['ZCode error -32602: Unrecognized key: "zcode.nodePath"',"compatibility","retry"],
  ["ZCode error -32602: Invalid params — Unrecognized key: \"newField\"","compatibility","retry"],
  ["ECONNRESET","network","retry"],
  ["ZCode process exited","network","retry"],
  ["EPERM: permission denied","access","retry"],
  ["会话同步失败：无法读取快照","synchronization","retry"],
  ["會話同步失敗：無法讀取快照","synchronization","retry"],
  ["Session sync failed: snapshot unavailable","synchronization","retry"],
  ["Unexpected failure: <script>中文原始诊断</script>","general","pickModel"],
];
test("common diagnostics map to actionable recovery instead of log-only errors",()=>{
  for(const [source,category,action] of cases){const guidance=errorGuidance(source);assert.equal(guidance.category,category,source);assert.equal(guidance.action,action);assert.ok(guidance.hint.length);}
  assert.match(errorGuidance(cases[0][0]).hint,/zcode\.binaryPath.*resources\/glm\/zcode\.cjs/);
  assert.match(errorGuidance("No available model").hint,/重新选择.*重试/);
  assert.match(errorGuidance("ZCode error -32602: Unrecognized key: \"newField\"").hint,/3\.12\.3–3\.16\.3/);
  assert.notEqual(errorGuidance("会话同步失败").category,"compatibility");
  assert.equal(errorGuidance("会话同步失败：401 Unauthorized").category,"login");
  assert.equal(errorGuidance("Session sync failed: ZCode error -32602: Invalid params").category,"compatibility");
  assert.notEqual(errorGuidance("Model API returned invalid params").category,"compatibility");
  assert.match(errorGuidance('ZCode error -32602: Invalid params').hint,/参数有误/);
});
test("all recovery labels and instructions are translated without translating diagnostics",()=>{
  for(const [source] of cases){const guidance=errorGuidance(source);for(const key of [guidance.title,guidance.hint,guidance.label]){
    assert.doesNotMatch(translate(key,"en"),/[\u4e00-\u9fff]/);
    assert.ok(traditionalMessages[key],key);
  }}
  assert.equal(new URL(COMMUNITY_URL).hostname,"marketplace.visualstudio.com");
});
