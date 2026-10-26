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
    for (const key of ["生成中", "正在停止", "切换会话", "读取登录", "连接中", "正在启动服务", "正在恢复上次会话", "等待模型响应"] as const) {
      assert.doesNotMatch(translate(key, locale), /(?:…|\.{3})$/, `${locale} ${key}`);
    }
  }
});

test("startup wait and session refresh notices translate with matching placeholders", () => {
  assert.equal(translate("已等待 {0} 秒 · 草稿会保留", "en", { 0: 12 }), "Waited 12s · Your draft will be kept");
  assert.equal(translate("已等待 {0} 秒 · 草稿会保留", "zh-TW", { 0: 12 }), "已等待 12 秒 · 草稿會保留");
  assert.equal(translate("刷新失败，当前显示上次结果", "en"), "Refresh failed; showing the previous result");
  assert.equal(translate("会话列表加载失败", "zh-TW"), "會話清單載入失敗");
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
