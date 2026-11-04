import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { splitZaiBuiltin, formatZaiToolOutput, formatImageAnalysisOutput } from "./zaiBuiltin";

test("tool labels in inline code stay readable without hiding later real tools", () => {
 const literal='**Z.ai Built-in Tool: webReader**';
 const actual='**Z.ai Built-in Tool: analyze_image**\n```json\n{}\n```\n**Output:**\n**analyze_image_result_summary:** [{"text":"真实结果"}]';
 for(const code of ['`'+literal+'`','``'+literal+' and `a` **Output:**``']){
  const source='示例：'+code+' 后面还有说明。';
  assert.deepEqual(splitZaiBuiltin(source),[{kind:'text',text:source}]);
  const parts=splitZaiBuiltin(source+'\n\n'+actual);
  assert.deepEqual(parts.filter(part=>part.kind==='tool').map(part=>part.toolName),['analyze_image']);
  assert.equal(parts[0].kind,'text');
  assert.ok(parts[0].text.includes(source));
 }
 // A stray backtick in an earlier paragraph must not swallow a real header
 // whose tool name is itself wrapped in backticks.
 const parts=splitZaiBuiltin('未闭合的 ` 标记\n\n'+actual.replace(': analyze_image**',': `analyze_image`**'));
 assert.deepEqual(parts.filter(part=>part.kind==='tool').map(part=>part.toolName),['analyze_image']);
});

test("tool labels in fenced code remain ordinary content, including unclosed streams", () => {
 const literal='const example = "**Z.ai Built-in Tool: webReader**";\n**Output:**\n[]';
 const actual='**Z.ai Built-in Tool: analyze_image**\n```json\n{}\n```\n**Output:**\n**analyze_image_result_summary:** [{"text":"真实结果"}]';
 for(const [open,close] of [['```typescript','```'],['```text','```'],['~~~text','~~~'],['````markdown','````']]){
  const prefix='代码示例：\n'+open+'\n'+literal;
  assert.deepEqual(splitZaiBuiltin(prefix),[{kind:'text',text:prefix}]);
  const code=prefix+'\n'+close+'\n\n最终说明。';
  assert.deepEqual(splitZaiBuiltin(code),[{kind:'text',text:code}]);
  const parts=splitZaiBuiltin(code+'\n'+actual+'\n\n工具后的正常回复。');
  assert.deepEqual(parts[0],{kind:'text',text:code+'\n'});
  const tools=parts.filter(part=>part.kind==='tool');
  assert.deepEqual(tools.map(tool=>tool.toolName),['analyze_image']);
  assert.equal(tools[0].outputText,'真实结果');
  assert.deepEqual(parts.at(-1),{kind:'text',text:'工具后的正常回复。'});
 }
 const nested='````markdown\n```text\n'+literal+'\n```\n````';
 assert.deepEqual(splitZaiBuiltin(nested),[{kind:'text',text:nested}]);
});

test("backtick strings inside JSON parameters are not code-fence boundaries", () => {
 const prompt='说明 ``` 和 **Output:**、**Z.ai Built-in Tool: webReader** 的含义';
 const input=JSON.stringify({prompt});
 const raw='**Z.ai Built-in Tool: analyze_image**\n```json\n'+input+'\n```\n**Output:**\n**analyze_image_result_summary:** [{"text":"结果"}]\n\n正常回复。';
 const parts=splitZaiBuiltin(raw),tools=parts.filter(part=>part.kind==='tool');
 assert.equal(tools.length,1);
 assert.equal(tools[0].inputText,input);
 assert.equal(tools[0].outputText,'结果');
 assert.deepEqual(parts.at(-1),{kind:'text',text:'正常回复。'});
});

test("Output labels inside parameters and result strings remain data", () => {
 const prompt='截图中的 **Output:** 和 **输出：** 是什么？';
 const text='这是 **Output:** 字段，**输出：** 也是正文。';
 for(const outputLabel of ['**Output:**','**输出：**']){
  const image='**Z.ai Built-in Tool: analyze_image**\n```json\n'+JSON.stringify({prompt})+'\n```\n'+outputLabel+'\n**analyze_image_result_summary:** '+JSON.stringify([{text}]);
  const next='**Z.ai Built-in Tool: webReader**\n```json\n'+JSON.stringify({prompt})+'\n```\n'+outputLabel+'\n'+JSON.stringify([{text}]);
  const parts=splitZaiBuiltin(image+'\n\n图片后的正常回复。\n'+next+'\n\n最后回复。');
  const tools=parts.filter(part=>part.kind==='tool');
  assert.deepEqual(tools.map(tool=>tool.toolName),['analyze_image','webReader']);
  for(const tool of tools){
   assert.equal(tool.inputText,JSON.stringify({prompt}));
   assert.equal(tool.outputText,text);
   assert.equal(tool.status,'completed');
  }
  assert.ok(parts.some(part=>part.kind==='text'&&part.text.includes('图片后的正常回复。')));
  assert.deepEqual(parts.at(-1),{kind:'text',text:'最后回复。'});
 }
});

test("Output labels inside complete or streaming parameters do not complete a tool", () => {
 const input=JSON.stringify({prompt:'截图中的 **Output:** 是什么？'});
 for(const suffix of ['\n```\n*Executing on server...*','']){
  assert.deepEqual(splitZaiBuiltin('**Z.ai Built-in Tool: analyze_image**\n```json\n'+input+suffix),[
   {kind:'tool',toolName:'analyze_image',inputText:input,outputText:'',status:'running'}
  ]);
 }
});

test("tool-like headings inside parameters and result strings remain data", () => {
 const literal='图片中的日志标题为 **Z.ai Built-in Tool: webReader**，其后有正文。';
 const image='**Z.ai Built-in Tool: analyze_image**\n```json\n'+JSON.stringify({prompt:literal})+'\n```\n**Output:**\n**analyze_image_result_summary:** '+JSON.stringify([{text:JSON.stringify(literal)}]);
 const next='**Z.ai Built-in Tool: webReader**\n```json\n{}\n```\n**Output:**\n'+JSON.stringify([{text:'网页内容'}]);
 const parts=splitZaiBuiltin(image+'\n\n图片后的正常回复。\n'+next+'\n\n最后回复。');
 const tools=parts.filter(part=>part.kind==='tool');
 assert.deepEqual(tools.map(tool=>tool.toolName),['analyze_image','webReader']);
 assert.equal(tools[0].inputText,JSON.stringify({prompt:literal}));
 assert.equal(tools[0].outputText,literal);
 assert.equal(tools[1].outputText,'网页内容');
 assert.ok(parts.some(part=>part.kind==='text'&&part.text.includes('图片后的正常回复。')));
 assert.deepEqual(parts.at(-1),{kind:'text',text:'最后回复。'});
 assert.equal(formatImageAnalysisOutput(JSON.stringify([{text:literal}])),literal);
});

test("a quoted tool heading in truncated output cannot create a phantom tool", () => {
 const literal='图片文字 **Z.ai Built-in Tool: webReader** 和 **Output:** 仍属于图片。';
 const raw='**Z.ai Built-in Tool: analyze_image**\n```json\n{}\n```\n**Output:**\n**analyze_image_result_summary:** [{"text":'+JSON.stringify(literal).slice(0,-1)+'\n                                                最后回复。';
 const parts=splitZaiBuiltin(raw),tools=parts.filter(part=>part.kind==='tool');
 assert.equal(tools.length,1);
 assert.ok(tools[0].outputText.includes(literal));
 assert.deepEqual(parts.at(-1),{kind:'text',text:'最后回复。'});
});

test("recorded truncated image summary recovers nested text and preserves the following reply", () => {
 const raw=readFileSync("src/testFixtures/image-analysis-truncated.txt","utf8");
 const parts=splitZaiBuiltin(raw);
 const tool=parts.find(part=>part.kind==="tool");
 assert.equal(tool?.kind,"tool");
 if(tool?.kind!=="tool") return;
 const output=tool.outputText;
 assert.ok(output.startsWith("# 图片内容描述\n\n## 界面布局"));
 assert.ok(output.includes("圆形按钮")&&output.includes("Tool AskUserQuestion requires user interaction"));
 assert.doesNotMatch(output,/result_summary|\[\{"text"|\\n/);
 assert.match(output,/不完整|incomplete/i);
 assert.ok(!output.includes("看到了，这张截图"),"following assistant prose leaked into the image result");
 assert.ok(parts.some(part=>part.kind==="text"&&part.text.includes("看到了，这张截图")&&part.text.includes("还想试试多选题或带预览面板的形态吗？")),"following reply was truncated");

 const result=raw.slice(raw.indexOf("**Output:**")+"**Output:**".length).split(/\n[ \t]{8,}(?=\S)/,1)[0].trim();
 for(const value of [result,result.replace(/^\*\*analyze_image_result_summary:\*\*\s*/,"")]){
  const direct=formatImageAnalysisOutput(value);
  assert.ok(direct.startsWith("# 图片内容描述\n\n## 界面布局"));
  assert.ok(direct.includes("Tool AskUserQuestion requires user interaction"));
  assert.doesNotMatch(direct,/result_summary|\[\{"text"|\\n/);
  assert.match(direct,/不完整|incomplete/i);
 }
});

test("image result decoding preserves trailing diagnostics after a complete JSON prefix", () => {
 const body="# 图片内容描述\n\n完整正文。";
 const tail="Tool AskUserQuestion requires user interaction";
 const output=formatImageAnalysisOutput(JSON.stringify([{text:JSON.stringify(body)}])+"\n"+tail);
 assert.ok(output.includes(body)&&output.includes(tail));
 assert.doesNotMatch(output,/\[\{"text"|\\n|不完整|incomplete/i);
});

test("truncated image text keeps received lines through one or two string layers", () => {
 const text="图片标题\n\n已收到的正文\nTool AskUserQuestion requires user interaction";
 const single='[{"text":'+JSON.stringify(text).slice(0,-1);
 const double='[{"text":'+JSON.stringify(JSON.stringify(text)).slice(0,-3);
 for(const raw of [single,double]){
  const output=formatImageAnalysisOutput(raw);
  assert.ok(output.startsWith(text));
  assert.doesNotMatch(output,/\[\{"text"|\\n/);
  assert.match(output,/不完整|incomplete/i);
 }
});

test("image decoding does not rewrite literal paths or invent a truncated escape", () => {
 const text='Path C:\\new\\notes.txt; keep literal \\n and \\t.';
 assert.equal(formatImageAnalysisOutput(text),text);
 assert.equal(formatImageAnalysisOutput(JSON.stringify([{text}])),text);
 const quoted='"Use C:\\new\\notes.txt';
 assert.equal(formatImageAnalysisOutput(quoted),quoted,"ordinary quoted prose must not be treated as a transport string");
 assert.equal(formatImageAnalysisOutput(JSON.stringify([{text:quoted}])),quoted,"a complete envelope does not make quoted prose a truncated JSON string");
 const output=formatImageAnalysisOutput('[{"text":"received'+"\\");
 assert.equal(output.split("\n\n")[0],"received");
 assert.match(output,/不完整|incomplete/i);
});
test("recorded image-service failure unwraps without hiding the actual 400 error", () => {
 const output="**Output:**\n**analyze_image_result_summary:** [{\"text\": \"MCP error 400: 400 Bad Request: \\\"{\\\"error\\\":{\\\"code\\\":\\\"1210\\\",\\\"message\\\":\\\"图片输入格式/解析错误\\\"}}\\\"\", \"type\": \"text\"}]";
 const expected='MCP error 400: 400 Bad Request: "{"error":{"code":"1210","message":"图片输入格式/解析错误"}}"';
 const parts=splitZaiBuiltin('图片已上传，我用视觉模型读取截图内容：**🌐 Z.ai Built-in Tool: analyze_image**\n\n**Input:**\n```json\n{}\n```\n*Executing on server...*\n'+output);
 assert.equal(parts[1].kind,"tool");
 if(parts[1].kind==="tool") assert.equal(parts[1].outputText,expected);
 assert.equal(formatImageAnalysisOutput(output),expected);
 assert.deepEqual(splitZaiBuiltin(output),[{kind:"text",text:expected}]);
 assert.deepEqual(splitZaiBuiltin(output+'\n\n仍需检查图片地址。'),[{kind:"text",text:expected+'\n\n仍需检查图片地址。'}]);
});
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

test("image-analysis summary marker and double-encoded text render as readable analysis", () => {
 const text="1) First row: **ZCode team plan**\n\n2) Yes — the note appears at the card's top right.";
 const raw='**analyze_image_result_summary:** '+JSON.stringify([{text:JSON.stringify(text)}]);
 const builtin=`**Z.ai Built-in Tool: analyze_image**\n\`\`\`json\n{"imageSource":"image"}\n\`\`\`\n**Output:**\n${raw}`;
 const segment=splitZaiBuiltin(builtin)[0];
 assert.equal(formatImageAnalysisOutput(raw),text);
 assert.equal(segment.kind,"tool");
 if(segment.kind==="tool") assert.equal(segment.outputText,text);
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
