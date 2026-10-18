import assert from "node:assert/strict";
import test from "node:test";
import { resolveUiLanguage, translate, setUiLanguage, relocalizeUiText } from "./i18n";
import { getWebviewHtml } from "./webviewHtml";
import type { Webview, Uri } from "vscode";

test("automatic language follows supported VS Code locales and explicit choices win", () => {
  assert.equal(resolveUiLanguage("auto", "zh-cn"), "zh-CN");
  assert.equal(resolveUiLanguage("auto", "zh-hant"), "zh-TW");
  assert.equal(resolveUiLanguage("auto", "en-US"), "en");
  assert.equal(resolveUiLanguage("en", "zh-cn"), "en");
  assert.equal(resolveUiLanguage("zh-CN", "en"), "zh-CN");
  assert.equal(resolveUiLanguage("auto", "fr"), "en");
});

test("UI translations interpolate values literally and preserve unknown content", () => {
  assert.equal(translate("已工作 {0}", "en", { 0: "1m 5s" }), "Worked 1m 5s");
  assert.equal(translate("界面语言", "zh-TW"), "介面語言");
  assert.equal(translate("{0} 需要权限", "en", { 0: "$&<tool>" }), "$&<tool> requires approval");
  assert.equal(translate("Custom tool response", "zh-CN"), "Custom tool response");
});

test("existing UI labels can change languages without reconstructing chat", () => {
  setUiLanguage("en");
  assert.equal(relocalizeUiText("等待模型响应"), "Waiting for model response");
  assert.equal(relocalizeUiText("已工作 1分 5秒"), "已工作 1分 5秒");
  setUiLanguage("zh-CN");
  assert.equal(relocalizeUiText("Waiting for model response"), "等待模型响应");
  assert.equal(relocalizeUiText("Worked 1m 5s"), "Worked 1m 5s");
});

test("in-progress status labels do not append ellipses in any supported UI language", () => {
  for (const locale of ["zh-CN", "zh-TW", "en"] as const) {
    for (const key of ["生成中", "正在停止", "切换会话", "读取登录", "连接中", "等待模型响应"] as const) {
      assert.doesNotMatch(translate(key, locale), /(?:…|\.{3})$/, `${locale} ${key}`);
    }
  }
});

test("initial webview renders the selected language before its first message", () => {
  const webview = { cspSource: "test:", asWebviewUri: () => "test:webview.js" } as unknown as Webview;
  const html = getWebviewHtml(webview, {} as Uri, "test-nonce", { locale: "en", setting: "auto", vscodeLanguage: "en" });
  assert.match(html, /<html lang="en" data-ui-language="en" data-language-setting="auto"/);
  assert.ok(html.includes('placeholder="Ask ZCode, @ to add context, / to choose capabilities"'));
  assert.ok(html.includes('id="btn-settings" title="Settings"'));
  assert.ok(html.includes('>Follow VS Code</option>'));
  assert.ok(html.indexOf("New chat defaults") < html.indexOf("Interface"));
  assert.ok(html.includes('id="default-session-model"'));
  assert.ok(html.includes('id="default-session-mode"'));
  assert.ok(html.includes('id="default-session-thought"'));
  assert.ok(html.includes("Reasoning options depend on the model."));
});
