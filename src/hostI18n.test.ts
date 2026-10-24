import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { hostT, userFacingError } from "./hostI18n";
import { LocalizedError, messages, setUiLanguage, translate, relocalizeUiText } from "./i18n";
import { traditionalMessages } from "./i18n.zhTW";
import { setTestLanguage } from "./testSupport/vscode";

test("host notices read the preference on every call, independently of webview state", () => {
  try {
    setUiLanguage("zh-CN");
    setTestLanguage("auto", "en-US");
    assert.equal(hostT("已重命名"), "Renamed");
    setTestLanguage("zh-TW", "en-US");
    assert.equal(hostT("请先归档再删除"), "請先歸檔再刪除");
    setTestLanguage("en");
    assert.equal(hostT("删除会话「{0}」？会从侧栏移除，与 ZCode 桌面端删除一致。", { 0: "中文标题 $&" }),
      "Delete session “中文标题 $&”? It will be removed from the sidebar, as in the ZCode desktop app.");
    assert.equal(hostT("会话已删除"), "Session deleted");
    assert.equal(hostT("没有打开的编辑器。"), "No editor is open.");
    setTestLanguage("auto", "zh-CN");
    assert.equal(hostT("Session archived"), "会话已归档");
  } finally { setTestLanguage("auto"); }
});

test("owned database errors translate while external diagnostics and interpolated data stay intact", () => {
  try {
    const cause = new Error("native failure: 文件.db");
    const error = new LocalizedError("当前 VS Code 运行环境不支持原生 SQLite，请更新 VS Code 后重试。", {}, { cause });
    setTestLanguage("en");
    assert.match(userFacingError(error), /^This VS Code runtime does not support native SQLite\./);
    assert.equal(error.cause, cause);
    assert.equal(userFacingError(new LocalizedError("已设置的 zcode.binaryPath 不存在：{0}", { 0: "/路径/文件 $&" })),
      "The configured zcode.binaryPath does not exist: /路径/文件 $&");
    assert.equal(userFacingError(cause), cause.message);
    const leaked = userFacingError(new LocalizedError("已设置的 zcode.binaryPath 不存在：{0}", { 0: "/opt/sk-abcdefghijklmnop/zcode Authorization: Bearer abcdefghijkl" }));
    assert.doesNotMatch(leaked, /sk-abcdefghijklmnop|abcdefghijkl/);
    assert.match(leaked, /^The configured zcode\.binaryPath does not exist: \/opt\/\[REDACTED\]\/zcode Authorization: \[REDACTED\]$/);
    setTestLanguage("auto", "zh-CN");
    assert.equal(
      userFacingError(new Error("ZCode error -32010: Cannot manage goals while a prompt is running")),
      "正在回复时不能修改或清除目标。可以先暂停，或等这轮结束再操作。"
    );
    assert.equal(
      userFacingError(new Error("ZCode error -32010: Plan and Goal cannot be active at the same time.")),
      "计划模式和目标不能同时使用。先退出其中一个再继续。"
    );
    setTestLanguage("zh-TW");
    assert.match(userFacingError(error), /請更新 VS Code 後重試/);
  } finally { setTestLanguage("auto"); }
});

test("every UI key has an explicit traditional translation with identical placeholders", () => {
  assert.deepEqual(Object.keys(traditionalMessages).sort(), Object.keys(messages).sort());
  for (const [key, value] of Object.entries(traditionalMessages)) {
    assert.deepEqual(value.match(/\{\d+\}/g)?.sort() ?? [], key.match(/\{\d+\}/g)?.sort() ?? [], key);
  }
  assert.equal(translate("折叠这一轮", "zh-TW"), "摺疊這一輪");
  assert.equal(translate("模型未能完成本轮回复", "zh-TW"), "模型未能完成本輪回覆");
  assert.equal(translate("{0} 需要权限", "zh-TW", { 0: "头发、后台、发布" }), "头发、后台、发布 需要權限");
  assert.equal(translate("用户原文：头发、后台、发布", "zh-TW"), "用户原文：头发、后台、发布");
});

test("dynamic labels cannot be reverse-matched as translation templates", () => {
  setUiLanguage("en");
  assert.equal(relocalizeUiText("某个工具 需要权限"), "某个工具 需要权限");
  assert.equal(relocalizeUiText("已工作 文字 需要权限"), "已工作 文字 需要权限");
  assert.equal(relocalizeUiText("{0} 需要权限"), "{0} 需要权限");
  setUiLanguage("zh-CN");
});

test("host Chinese UI literals must use translation keys; persisted default titles are exempt", () => {
  const file = ts.createSourceFile("extension.ts", readFileSync("src/extension.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const failures: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && /\p{Script=Han}/u.test(node.text)) {
      let current: ts.Node | undefined = node.parent;
      while (current && !ts.isCallExpression(current) && !ts.isFunctionLike(current)) current = current.parent;
      const translated = current && ts.isCallExpression(current) && current.expression.getText(file) === "t";
      // Stored session titles belong to the conversation, rather than interface text.
      if (!translated && node.text !== "新会话") failures.push(`${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${node.text}`);
      if (translated && ts.isStringLiteral(node)) assert.ok(Object.hasOwn(messages, node.text), `Missing key: ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.deepEqual(failures, []);
});

test("Chinese translation and owned error keys across UI sources must exist in the dictionary", () => {
  for (const name of ["extension", "webview/main", "webviewHtml", "sessionUi", "taskIndex", "serverPath", "zcodeClient"]) {
    const file = ts.createSourceFile(`${name}.ts`, readFileSync(`src/${name}.ts`, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if ((ts.isCallExpression(node) && node.expression.getText(file) === "t") ||
          (ts.isNewExpression(node) && node.expression.getText(file) === "LocalizedError")) {
        const key = node.arguments?.[0];
        if (key && ts.isStringLiteral(key) && /\p{Script=Han}/u.test(key.text)) {
          assert.ok(Object.hasOwn(messages, key.text), `${name}: missing key ${key.text}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
});
