import test from "node:test";
import assert from "node:assert/strict";
import { splitZaiBuiltin, formatZaiToolOutput, formatImageAnalysisOutput } from "./zaiBuiltin";
test("image-analysis builtin transitions from running to complete without truncating output", () => {
 const start = '**Z.ai Built-in Tool: analyze_image**\n```json\n{"imageSource":"https://example.invalid/image"}\n```\n*Executing on server...*';
 assert.equal(splitZaiBuiltin(start)[0].kind,"tool");
 const output = '第一段\n\n'+ '图片分析内容'.repeat(250) + '\n最后一句';
 const segments = splitZaiBuiltin(start+'\n**Output:**\n**analyze_image_result_summary:** '+JSON.stringify([{text:output}]));
 assert.equal(segments[0].kind,"tool");
 if (segments[0].kind === "tool") { assert.equal(segments[0].status,"completed"); assert.equal(segments[0].outputText,output); }
 assert.equal(formatZaiToolOutput('**analyze_image_result_summary:** '+JSON.stringify([{text:output}])),output);
});

test("native image-analysis output decodes text-content and JSON-string layers without rewriting prose", () => {
 const text="第一段\n\n**标题**\n末尾";
 assert.equal(formatImageAnalysisOutput(JSON.stringify([{text:JSON.stringify(text)}])),text);
 assert.equal(formatImageAnalysisOutput(JSON.stringify({content:[{type:"text",text}]})),text);
 assert.equal(formatImageAnalysisOutput('literal \\n path'), 'literal \\n path');
});

test("Chinese builtin headers split the tool from the surrounding prose", () => {
  const body = '\n\n**输入：**\n```json\n{"imageSource":"https://example.invalid/shot.png"}\n```\n**输出：**\n**analyze_image_result_summary:** '+JSON.stringify([{text:"画面正常"}]);
  const colon = splitZaiBuiltin("先看第二段。**🌐 Z.ai 内置工具：analyze_image**"+body+"\n\n曲线完整。");
  assert.equal(colon.length, 3);
  assert.equal(colon[0].kind, "text");
  if (colon[1].kind === "tool") {
    assert.equal(colon[1].toolName, "analyze_image");
    assert.equal(colon[1].status, "completed");
    assert.equal(colon[1].outputText, "画面正常");
  }
  assert.deepEqual(colon[2], {kind:"text", text:"曲线完整。"});
  const ticks = splitZaiBuiltin("**🌐 Z.ai 内置工具: `analyze_image`**\n\n**输入：**\n```json\n{}\n```\n**输出：**\n**`analyze_image_result_summary`:** "+JSON.stringify([{text:"柱子对齐"}])+"\n\n最后一段。");
  assert.equal(ticks[0].kind, "tool");
  if (ticks[0].kind === "tool") assert.equal(ticks[0].outputText, "柱子对齐");
  assert.deepEqual(ticks[1], {kind:"text", text:"最后一段。"});
});

test("complete builtin JSON output ends before unindented final prose", () => {
 const raw='**Z.ai Built-in Tool: analyze_image**\n```json\n{}\n```\n**Output:**\n**analyze_image_result_summary:** '+JSON.stringify([{text:'a brace } and escaped quote " within output'}]);
 const parts=splitZaiBuiltin(raw+'\n\nFinal reply');
 assert.equal(parts.length,2); assert.deepEqual(parts[1],{kind:"text",text:"Final reply"});
 if(parts[0].kind==="tool") assert.equal(parts[0].outputText,'a brace } and escaped quote " within output');
});
