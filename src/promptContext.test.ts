import assert from "node:assert/strict";
import test from "node:test";
import { buildPrompt, parsePromptDisplay, fileMarkdownRef, stripSessionReferences, extractLeadingSkills, extractLeadingAgents, markdownLinkRef } from "./promptContext";

test("serialized subagent mentions restore qualified names and the prompt", () => {
  assert.deepEqual(extractLeadingAgents("@Explore @demo:reviewer Please review"), {
    agents: [{ name: "Explore" }, { name: "demo:reviewer" }], text: "Please review",
  });
});

test("skill references restore as selections and retain a prompt beginning with a code fence", () => {
  const first = { name: "alpha", path: "/My Skills/alpha/SKILL.md" };
  const second = { name: "beta", path: "C:\\Skills\\beta\\SKILL.md" };
  const text = `${markdownLinkRef(`$${first.name}`, first.path)}\n\n${markdownLinkRef(`$${second.name}`, second.path)}\n\n\`\`\`js\nconsole.log(1)\n\`\`\``;
  const parsed = parsePromptDisplay(text);
  assert.equal(parsed.chips.length, 2);
  assert.equal(parsed.body, "```js\nconsole.log(1)\n```");
  assert.deepEqual(extractLeadingSkills(text), { text: parsed.body, skills: [first, { ...second, path: "C:/Skills/beta/SKILL.md" }] });
});
test("special file names and line ranges round trip without broken Markdown", () => {
  const chip={path:"/work/a (1)#%.ts",relPath:"a (1)#%.ts",selectionStart:2,selectionEnd:3,selectedText:"sample"};
  assert.match(fileMarkdownRef(chip), /<\.\/a \(1\)%23%25.ts#L2-L3>/);
  const display=parsePromptDisplay(buildPrompt("explain",[chip]));
  assert.equal(display.body,"explain"); assert.equal(display.chips[0].title,"./a (1)#%.ts (L2-L3)");
});
test("unsaved snapshots containing code fences remain a single reference", () => {
  const snapshot="# code\n```ts\nconst a=1\n```\n````";
  const prompt=buildPrompt("review",[{path:"/w/a.md",relPath:"a.md",snapshot,languageId:"markdown"}]);
  assert.ok(prompt.includes("`````md\n"+snapshot+"\n`````"));
  assert.deepEqual(parsePromptDisplay(prompt),{body:"review",chips:[{label:"a.md",title:"./a.md"}],sessionRefs:[]});
});
test("Windows duplicate references coalesce while POSIX case and distinct selections remain", () => {
  assert.equal(parsePromptDisplay(buildPrompt("q",[{path:"e:\\Work\\a.ts",relPath:"a.ts"},{path:"E:/work/a.ts",relPath:"a.ts",implicit:true}])).chips.length,1);
  assert.equal(parsePromptDisplay(buildPrompt("q",[{path:"/w/a.ts",relPath:"a.ts"},{path:"/w/A.ts",relPath:"A.ts"}])).chips.length,2);
});

test("workspace conversation references serialize in desktop format and round trip separately from files", () => {
  const reference={sessionId:"sess_11111111-1111-4111-8111-111111111111",title:"示例会话标题"};
  const prompt=buildPrompt("这个对话里学到了什么？",[{path:"/work/src/main.ts",relPath:"src/main.ts"}],[reference,reference,{sessionId:"invalid",title:"ignored"}]);
  assert.match(prompt,/^\[#示例会话标题\]\(#sess_11111111-1111-4111-8111-111111111111\)/);
  assert.ok(prompt.indexOf("[#示例会话标题]")<prompt.indexOf("[main.ts]"));
  assert.deepEqual(parsePromptDisplay(prompt),{
    body:"这个对话里学到了什么？",
    chips:[{label:"main.ts",title:"./src/main.ts"}],
    sessionRefs:[reference],
  });
  assert.equal(stripSessionReferences(prompt),"[main.ts](./src/main.ts)\n\n这个对话里学到了什么？");
});

test("conversation titles are kept on one safe Markdown line", () => {
  const prompt = buildPrompt("question", [], [{
    sessionId: "sess_11111111-1111-4111-8111-111111111111",
    title: "First line\n[second]",
  }]);
  assert.ok(prompt.startsWith("[#First line \\[second\\]](#sess_11111111-1111-4111-8111-111111111111)\n\nquestion"));
  assert.deepEqual(parsePromptDisplay(prompt).sessionRefs, [{
    sessionId: "sess_11111111-1111-4111-8111-111111111111",
    title: "First line [second]",
  }]);
});
