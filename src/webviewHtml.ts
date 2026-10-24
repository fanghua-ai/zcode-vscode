import { translate, type UiLanguage, type LanguageSetting } from "./i18n";
import * as vscode from "vscode";

export type ComposerChrome = {
  showQuestionJump: boolean;
  showUsageChevron: boolean;
  showContextRing: boolean;
  showFiveHourRing: boolean;
  showConnectionStatus: boolean;
  sessionControlsIcons: boolean;
  foldSessionControls: boolean;
  frostedGlass: boolean;
};

const defaultChrome: ComposerChrome = {
  showQuestionJump: true,
  showUsageChevron: true,
  showContextRing: true,
  showFiveHourRing: true,
  showConnectionStatus: true,
  sessionControlsIcons: false,
  foldSessionControls: false,
  frostedGlass: true,
};

export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  nonce: string,
  language: { locale: UiLanguage; setting: LanguageSetting; vscodeLanguage: string } = { locale: "zh-CN", setting: "auto", vscodeLanguage: "zh-CN" },
  chrome: ComposerChrome = defaultChrome
): string {
  const t = (text: string) => translate(text, language.locale);
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview.js")
  );
  const formulaCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "math", "katex.min.css"));
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource} data:`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="${language.locale}" data-ui-language="${language.locale}" data-language-setting="${language.setting}" data-show-question-jump="${chrome.showQuestionJump}" data-show-usage-chevron="${chrome.showUsageChevron}" data-show-context-ring="${chrome.showContextRing}" data-show-five-hour-ring="${chrome.showFiveHourRing}" data-show-connection-status="${chrome.showConnectionStatus}" data-session-controls-icons="${chrome.sessionControlsIcons}" data-fold-session-controls="${chrome.foldSessionControls}" data-frosted-glass="${chrome.frostedGlass}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ZCode</title>
<link rel="stylesheet" href="${formulaCssUri}">
<style>
  .md .katex { font-size:1.08em; }
  .md .katex-display { margin: .75em 0; overflow-x:auto; overflow-y:hidden; padding:4px 0; max-width:100%; }
  .md .katex-display > .katex { display:block; width:max-content; min-width:100%; }
  :root {
    --z-accent: color-mix(in srgb, var(--vscode-focusBorder, var(--vscode-textLink-foreground, #5794d0)) 35%, var(--vscode-foreground) 65%);
    --z-accent-2: var(--z-accent);
    --z-warning: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 85%, var(--vscode-foreground) 15%);
    --z-floating-shadow: 0 8px 24px var(--vscode-widget-shadow, rgba(0,0,0,.16));
    --z-muted: color-mix(in srgb, var(--vscode-descriptionForeground, var(--vscode-foreground)) 50%, var(--vscode-foreground) 50%);
    --z-danger-text: color-mix(in srgb, var(--vscode-errorForeground, #f48771) 50%, var(--vscode-foreground) 50%);
    --radius: 10px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    height: 100%;
    font-family: var(--vscode-font-family, system-ui);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  }
  html {
    --z-blur: blur(22px) saturate(1.35);
    --z-blur-sheet: blur(24px) saturate(1.4);
  }
  html[data-frosted-glass="false"] {
    --z-blur: none;
    --z-blur-sheet: none;
  }
  body { overflow: hidden; position: relative; }
  body.vscode-light { color-scheme: light; }
  body.vscode-dark { color-scheme: dark; }
  input::placeholder, textarea::placeholder { color: var(--z-muted); opacity: 1; }

  #settings-menu {
    position: absolute; top: calc(100% + 4px); right: 0; z-index: 100;
    width: 280px; max-height: min(72vh, 440px); padding: 6px; border-radius: 10px;
    display: flex; flex-direction: column; gap: 6px;
    background: color-mix(in srgb, var(--vscode-menu-background, var(--vscode-editor-background)) 62%, transparent);
    border: 1px solid color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
    box-shadow: 0 16px 40px color-mix(in srgb, var(--vscode-widget-shadow, #000) 36%, transparent);
    backdrop-filter: var(--z-blur-sheet);
    -webkit-backdrop-filter: var(--z-blur-sheet);
    overflow: auto;
  }
  html[data-frosted-glass="false"] #settings-menu {
    background: var(--vscode-menu-background, var(--vscode-editor-background));
  }
  #settings-menu[hidden] { display: none; }
  .settings-section {
    margin: 12px 8px 2px;
    font-size: 12px;
    font-weight: 650;
    line-height: 16px;
    color: var(--vscode-foreground);
  }
  .settings-section:first-child { margin-top: 4px; }
  .settings-action {
    display: flex; align-items: center; width: 100%;
    margin: 0; padding: 6px 8px; border: 0; border-radius: 6px;
    background: transparent; color: inherit; font: inherit; font-size: 12px;
    line-height: 16px; text-align: left; cursor: pointer;
  }
  .settings-action:hover { background: var(--vscode-toolbar-hoverBackground); }
  .settings-switch {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    margin: 0; padding: 6px 8px; border-radius: 6px;
    font-size: 12px; line-height: 16px; cursor: pointer;
  }
  .settings-switch:hover { background: var(--vscode-toolbar-hoverBackground); }
  .switch { position: relative; width: 28px; height: 16px; flex: 0 0 auto; }
  .switch input { position: absolute; inset: 0; margin: 0; opacity: 0; cursor: pointer; }
  .switch i {
    display: block; height: 100%; border-radius: 999px; pointer-events: none;
    background: color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
  }
  .switch i::after {
    content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px;
    border-radius: 50%; background: var(--vscode-editor-background, #fff);
    transition: transform .12s ease;
  }
  .switch input:checked + i { background: var(--vscode-button-background, var(--z-accent)); }
  .switch input:checked + i::after { transform: translateX(12px); }
  .switch input:focus-visible + i { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .settings-item {
    display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 12px;
    width: 100%; margin: 0; padding: 6px 8px;
    border: 0; border-radius: 6px; background: transparent;
    color: var(--vscode-foreground); font: inherit; font-size: 12px;
    text-align: left;
  }
  .settings-select-group {
    display: flex; flex-direction: column; gap: 5px;
    margin: 0; padding: 4px 8px 6px;
  }
  .settings-select-label { font-size: 12px; line-height: 16px; color: var(--vscode-foreground); }
  .settings-select {
    width: 100%; min-width: 0; padding: 4px 7px;
    color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-widget-border)); border-radius: 5px;
    font: inherit; font-size: 12px; outline: none;
  }
  .settings-select:focus-visible { border-color: var(--vscode-focusBorder); }
  .settings-help { padding: 0 8px 4px; color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 15px; }
  button.settings-item { cursor: pointer; }
  button.settings-item:hover { background: var(--vscode-toolbar-hoverBackground); }
  html[data-show-question-jump="false"] #rail-toggle { display: none !important; }
  html[data-show-usage-chevron="false"] .usage-chevron { display: none !important; }
  html[data-show-usage-chevron="false"] #context-meter { cursor: default; }
  html[data-show-context-ring="false"] .context-ring { display: none !important; }
  html[data-show-five-hour-ring="false"] .five-hour-ring { display: none !important; }
  html[data-show-context-ring="false"][data-show-five-hour-ring="false"][data-show-usage-chevron="false"] #context-meter { display: none !important; }
  html[data-show-connection-status="false"] #conn-status { display: none !important; }
  #pending-action { position: absolute; right: 12px; top: -34px; max-width: calc(100% - 60px); padding: 5px 10px; font: inherit; font-size: 12px; border-radius: 8px; border: 1px solid var(--vscode-widget-border); background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); color: var(--z-accent); box-shadow: var(--z-floating-shadow); cursor: pointer; }
  #pending-action[hidden] { display: none; }
  .perm-card:focus, .ask-card:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  #language-label { margin: 0; font-size: 12px; line-height: 16px; color: var(--vscode-foreground); }
  #ui-language {
    width: auto; max-width: 58%; padding: 2px 6px; font: inherit; font-size: 12px;
    color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-widget-border)); border-radius: 4px;
  }
  #topbar {
    --z-chrome-bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px 8px 0;
    min-height: 48px;
    background: transparent;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }
  /* Opaque strip above the title card — no transcript peeking past the top edge. */
  #topbar::before {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 8px;
    z-index: 2;
    background: var(--z-chrome-bg);
    pointer-events: none;
  }
  #topbar::after {
    content: "";
    position: absolute;
    inset: 8px 8px 0;
    z-index: -1;
    border-radius: 12px;
    background: color-mix(in srgb, var(--z-chrome-bg) 74%, transparent);
    border: 1px solid color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
    box-shadow: 0 8px 24px color-mix(in srgb, var(--vscode-widget-shadow, #000) 32%, transparent);
    backdrop-filter: var(--z-blur);
    -webkit-backdrop-filter: var(--z-blur);
    pointer-events: none;
  }
  html[data-frosted-glass="false"] #topbar::after { background: var(--z-chrome-bg); }
  #session-title {
    flex: 1;
    min-width: 0;
    height: 32px;
    box-sizing: border-box;
    background: transparent;
    border: 1px solid transparent;
    color: inherit;
    font: inherit;
    font-weight: 500;
    font-size: 13px;
    line-height: 30px;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0 8px;
    border-radius: 8px;
    cursor: text;
  }
  #session-title:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,.08));
  }
  #session-title:focus {
    overflow: hidden;
    text-overflow: clip;
    background: var(--vscode-input-background);
    border-color: var(--vscode-focusBorder);
    outline: none;
  }
  .icon-btn {
    width: 28px; height: 28px; min-width: 28px;
    display: inline-flex; align-items: center; justify-content: center;
    background: transparent; color: var(--z-muted);
    border: 0; border-radius: 8px; padding: 0; cursor: pointer;
  }
  .icon-btn svg { width: 20px; height: 20px; }
  #topbar .icon-btn { width: 32px; height: 32px; min-width: 32px; }
  #topbar .icon-btn + .icon-btn { margin-left: -6px; }
  #topbar .icon-btn svg { width: 18px; height: 18px; }
  #topbar #btn-new svg { width: 16px; height: 16px; }
  .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,.08)); color: var(--vscode-foreground); }
  .copy-btn, #overlay-close, #setup-close, #btn-retry {
    background: var(--vscode-button-secondaryBackground, #3a3a3a);
    color: var(--vscode-button-secondaryForeground, #ddd);
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 4px 8px;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
  }
  .copy-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #4a4a4a); }
  #messages {
    position: absolute;
    inset: 0;
    z-index: 0;
    overflow-y: auto;
    padding: var(--z-messages-pad-top, 56px) 18px var(--z-messages-pad-bottom, 140px);
    display: flex;
    flex-direction: column;
    gap: 14px;
    /* Native bar is full-height and sits beside chrome cards — hide it. */
    scrollbar-width: none;
  }
  #messages::-webkit-scrollbar { width: 0; height: 0; display: none; }
  /* Soft rail flush with title-card bottom and input-card top. */
  #messages-scrollbar {
    position: absolute;
    right: 0;
    top: var(--z-messages-scroll-top, 48px);
    bottom: var(--z-messages-scroll-bottom, 120px);
    z-index: 5;
    width: 8px;
    display: flex;
    justify-content: center;
    pointer-events: auto;
    cursor: default;
  }
  #messages-scrollbar[hidden] { display: none; }
  #messages-thumb {
    width: 2px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
    will-change: transform;
  }
  #messages-scrollbar:hover #messages-thumb,
  #messages-scrollbar.is-dragging #messages-thumb {
    background: color-mix(in srgb, var(--vscode-foreground) 54%, transparent);
  }
  .empty {
    position: relative;
    margin: auto;
    text-align: center;
    width: 100%;
    max-width: 320px;
    min-height: 180px;
    padding: 63px 8px 24px;
  }
  .empty-mark {
    position: absolute;
    width: min(72%, 148px);
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    pointer-events: none;
    color: var(--vscode-foreground);
  }
  .empty-mark svg {
    display: block;
    width: 100%;
    height: auto;
    opacity: .52;
    mask-image: linear-gradient(to bottom, black 30%, transparent 90%);
  }
  body.vscode-light .empty-mark svg { opacity: .36; }
  .empty-title { position: relative; font-size: 15px; line-height: 1.5; font-weight: 500; text-wrap: balance; }

  .message { max-width: 100%; line-height: 1.55; }
  /* Desktop-parity tail spinner: alone at the transcript's bottom-left. */
  #working-indicator {
    align-self: flex-start;
    padding: 6px 2px 4px;
    color: var(--vscode-descriptionForeground, var(--z-muted));
  }
  #working-indicator svg {
    display: block;
    transform-origin: center;
    animation: working-spin 1.15s linear infinite;
  }
  @keyframes working-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    #working-indicator svg { animation: none; }
  }
  .message.user {
    position: relative;
    align-self: flex-end;
    background: color-mix(in srgb, var(--vscode-foreground) 9%, var(--vscode-editor-background));
    border: 0;
    border-radius: 16px;
    padding: 10px 14px;
    max-width: 86%;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .message.user.editing { max-width: 100%; }
  .message.user + .message.assistant,
  .message.user + .message.error {
    margin-top: 12px;
  }
  .message.assistant { align-self: stretch; padding: 4px 2px; line-height: 1.65; }
  /* A bit looser than the 4px bubble-to-copy gap; raw text needs more air. */
  .work-fold + .message.assistant { margin-top: -12px; padding-top: 0; }
  .message.assistant:has(+ .reply-meta) { padding-bottom: 0; }
  .msg-meta[hidden] { display: none; }
  .msg-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
    white-space: nowrap;
    font-size: 11px;
    line-height: 16px;
    color: var(--z-muted, var(--vscode-foreground));
  }
  .msg-meta.outside {
    align-self: flex-end;
    max-width: 86%;
    margin-top: -10px;
    justify-content: flex-end;
  }
  .msg-meta.reply-meta { margin-top: -4px; min-width: 0; }
  .msg-copy {
    width: 16px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .msg-copy svg { display: block; }
  .msg-copy:hover,
  .msg-copy:focus-visible {
    color: var(--vscode-foreground);
    background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
  }
  .msg-time { font-variant-numeric: tabular-nums; }
  .math-font-hint {
    border: 0; padding: 0; background: transparent; color: inherit;
    font: inherit; cursor: pointer;
    min-width: 0; overflow: hidden; text-overflow: ellipsis;
  }
  .math-font-hint:hover,
  .math-font-hint:focus-visible { color: var(--vscode-foreground); text-decoration: underline; }
  .math-font-hint:disabled,
  .math-font-hint:disabled:hover,
  .math-font-hint:disabled:focus-visible { cursor: default; color: inherit; text-decoration: none; }
  .turn-hidden { display: none !important; }
  .turn-collapsed,
  .turn-folded {
    cursor: pointer;
  }
  .turn-collapsed > :not(.fold-preview) {
    display: none;
  }
  .fold-preview {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    white-space: normal;
    word-break: break-word;
  }
  .turn-fold-bar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 30px;
    margin: 2px 0 8px;
    border: 1px solid color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
    border-radius: 8px;
    padding: 4px 8px 4px 10px;
    background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent);
    color: var(--vscode-foreground);
    font: inherit;
    font-size: 13px;
    line-height: 18px;
    text-align: left;
    cursor: pointer;
  }
  .turn-fold-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .turn-fold-bar:hover {
    background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent);
  }
  .turn-chevron {
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 1px solid color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
    border-radius: 999px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    color: var(--z-muted, var(--vscode-foreground));
    cursor: pointer;
  }
  .turn-chevron svg { display: block; }
  .turn-chevron.expand svg { transform: rotate(180deg); }
  .turn-collapse-btn,
  .turn-edit-btn,
  .question-fold-btn {
    position: static;
    width: 22px;
    height: 28px;
    border: 0;
    border-radius: 5px;
    background: transparent;
  }
  .msg-meta.outside { gap: 4px; }
  .msg-meta.outside .msg-copy { width: 22px; height: 22px; }
  .msg-meta.outside .question-fold-btn { width: 22px; height: 22px; }
  .msg-meta.outside .turn-chevron,
  .msg-meta.outside .msg-copy { border-radius: 4px; color: inherit; }
  .msg-meta.outside .turn-chevron:hover,
  .msg-meta.outside .turn-chevron:focus-visible {
    color: var(--vscode-foreground);
    background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
  }
  .turn-edit-btn[hidden] { display: none; }
  .turn-edit-btn.edit-pending { cursor: default; }
  .message.user:hover .turn-collapse-btn,
  .message.user:hover .turn-edit-btn,
  .turn-chevron:hover,
  .turn-chevron:focus-visible {
    opacity: 1;
    color: var(--vscode-foreground);
  }
  .turn-fold-bar .turn-chevron { flex: 0 0 auto; opacity: 0.7; }
  .message.error {
    align-self: stretch;
    color: var(--z-danger-text);
    background: color-mix(in srgb, var(--vscode-errorForeground, #f48771) 12%, transparent);
    border-radius: 8px;
    padding: 8px 10px;
    font-size: 12px;
    white-space: normal;
  }
  .err-title { font-weight:600; }
  .err-guidance { margin-top:6px; color:var(--vscode-foreground); line-height:1.5; }
  .error-details { margin-top:8px; color:var(--vscode-foreground); }
  .error-details summary { cursor:pointer; }
  .error-details pre { white-space:pre-wrap; overflow-wrap:anywhere; max-height:160px; overflow:auto; margin:6px 0 0; font-size:11px; }
  .err-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .err-actions button {
    background: var(--vscode-button-secondaryBackground, #3a3a3a);
    color: var(--vscode-button-secondaryForeground, #ddd);
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 3px 8px;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
  }
  .err-actions button:first-child { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
  .work-fold { align-self: stretch; margin: 0 0 8px; }
  .work-fold-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-width: 0;
    padding: 0 12px 6px 0;
    border: 0;
    border-bottom: 1px solid color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
    background: none;
    color: var(--z-muted);
    font: inherit;
    font-size: 12px;
    line-height: 18px;
    text-align: left;
    cursor: pointer;
  }
  .work-duration-row {
    display:flex; align-items:center; gap:6px; width:100%; min-width:0;
    padding:0 12px 6px 0;
    border-bottom:1px solid color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
    color:var(--z-muted); font:inherit; font-size:12px; line-height:18px; text-align:left;
  }
  .work-fold-btn .tool-chevron { width: 12px; height: 12px; border: 0; opacity: 1; transform: translateY(-0.5px) rotate(0deg); }
  .work-fold.open .work-fold-btn .tool-chevron { transform: translateY(-0.5px) rotate(180deg); }
  .work-fold-label { flex: 0 0 auto; white-space: nowrap; }
  .work-fold-viewport { display: none; position: relative; }
  .work-fold.open .work-fold-viewport { display: block; }
  .work-fold-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 8px;
    max-height: min(52vh, 480px);
    overflow-anchor: none;
    padding-right: 12px;
    box-sizing: border-box;
    overflow: auto;
    /* Native bars have a platform minimum thicker than the conversation rail. */
    scrollbar-width: none;
  }
  .work-fold-body::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
  .work-fold-body > * { flex-shrink: 0; }
  .builtin-work { display: flex; flex-direction: column; gap: 10px; }
  .soft-scroll {
    position: absolute;
    z-index: 2;
    pointer-events: auto;
  }
  .soft-scroll[hidden] { display: none; }
  .soft-scroll.y {
    top: 0;
    right: 0;
    bottom: 0;
    width: 8px;
    display: flex;
    justify-content: center;
    align-items: flex-start;
  }
  .soft-scroll.x {
    left: 6px;
    right: 6px;
    bottom: 1px;
    height: 2px;
    display: flex;
    align-items: flex-end;
    justify-content: flex-start;
  }
  .soft-scroll .soft-thumb {
    border-radius: 999px;
    background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
    flex: 0 0 auto;
  }
  .soft-scroll.y .soft-thumb { width: 2px; }
  .soft-scroll.x .soft-thumb {
    height: 2px;
    background: color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
  }
  .soft-scroll:hover .soft-thumb,
  .soft-scroll.is-dragging .soft-thumb {
    background: color-mix(in srgb, var(--vscode-foreground) 48%, transparent);
  }
  /* Keep the conversation's secondary scrollbars a little easier to spot. */
  .work-fold-viewport > .soft-scroll.y .soft-thumb {
    background: color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
  }
  .work-fold-viewport > .soft-scroll.y:hover .soft-thumb,
  .work-fold-viewport > .soft-scroll.y.is-dragging .soft-thumb {
    background: color-mix(in srgb, var(--vscode-foreground) 54%, transparent);
  }
  #question-rail .soft-scroll.x .soft-thumb {
    background: color-mix(in srgb, var(--vscode-foreground) 22%, transparent);
  }
  #question-rail .soft-scroll.x:hover .soft-thumb,
  #question-rail .soft-scroll.x.is-dragging .soft-thumb {
    background: color-mix(in srgb, var(--vscode-foreground) 54%, transparent);
  }
  .soft-scroll[hidden] { display: none !important; }
  .work-note {
    padding: 0 0 0 24px;
    font-size: 12px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .md { word-break: break-word; }
  .md strong { font-weight: 700; }
  .md p { margin: 0 0 .7em; }
  .md p:last-child { margin-bottom: 0; }
  .md h1,.md h2,.md h3,.md h4 { font-size: 1.12em; font-weight: 600; margin: 1.15em 0 .45em; }
  .md ul,.md ol { padding-left: 1.3em; margin: 0 0 .7em; }
  .md blockquote {
    border-left: 3px solid var(--z-accent);
    margin: .5em 0;
    padding: .2em 0 .2em .8em;
    opacity: .9;
  }
  .md table { border-collapse: collapse; margin: .6em 0; width: 100%; font-size: 12px; }
  .md th,.md td { border: 1px solid var(--vscode-panel-border, #333); padding: 4px 8px; }
  .md a { color: var(--vscode-textLink-foreground); }
  .md code {
    font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
    font-size: .92em;
    background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
    padding: 0 4px;
    border-radius: 4px;
  }
  .code-block {
    margin: 8px 0 12px;
    border: 1px solid var(--vscode-panel-border, #333);
    border-radius: 8px;
    overflow: hidden;
    background: var(--vscode-textCodeBlock-background, #111);
  }
  .code-toolbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 4px 8px;
    font-size: 11px;
    border-bottom: 1px solid var(--vscode-panel-border, #333);
    color: var(--z-muted);
  }
  .code-block pre {
    margin: 0;
    padding: 10px 12px;
    overflow-x: auto;
    font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
    font-size: 12px;
    line-height: 1.45;
  }
  .code-block code { background: transparent; padding: 0; }
  .hljs { color: var(--vscode-editor-foreground); }
  .hljs-keyword,.hljs-selector-tag { color: var(--vscode-symbolIcon-keywordForeground, #c586c0); }
  .hljs-string { color: var(--vscode-debugTokenExpression-string, #ce9178); }
  .hljs-number { color: color-mix(in srgb, var(--vscode-debugTokenExpression-number, var(--vscode-editor-foreground)) 80%, var(--vscode-editor-foreground) 20%); }
  .hljs-comment { color: var(--z-muted); font-style: italic; }
  .hljs-title,.hljs-title.function_,.hljs-attr,.hljs-attribute { color: color-mix(in srgb, var(--vscode-debugTokenExpression-name, var(--vscode-editor-foreground)) 90%, var(--vscode-editor-foreground) 10%); }
  .hljs-built_in,.hljs-type { color: var(--vscode-editor-foreground); }

  .tool-call {
    background: transparent;
    padding: 2px 0;
    font-size: 12px;
  }
  .message.assistant .tool-call { margin: 8px 0; }
  .tool-head {
    display: flex; gap: 8px; align-items: center;
    width: 100%;
    background: none; border: 0; padding: 0;
    color: inherit; font: inherit; line-height: 18px; text-align: left;
    cursor: pointer;
  }
  .tool-chevron {
    flex: 0 0 auto;
    width: 0; height: 0;
    border-style: solid;
    border-width: 4px 0 4px 6px;
    border-color: transparent transparent transparent currentColor;
    opacity: .7;
    transform: rotate(90deg);
    transition: transform .12s ease;
  }
  .tool-call.collapsed .tool-chevron { transform: rotate(0deg); }
  .tool-call.collapsed .tool-body { display: none; }
  .tool-name { font-weight: 400; color: var(--z-muted); flex-shrink: 0; }
  .tool-head { color: var(--z-muted); min-height: 24px; }
  .tool-name, .tool-preview { line-height: 18px; }
  .tool-preview { min-width: 0; flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .tool-body { padding-left: 24px; }
  .tool-status { flex-shrink: 0; }
  .tool-status.completed, .tool-status.success { display: none; }
  .process-head { display: flex; align-items: center; gap: 8px; min-height: 24px; background: none; border: 0; padding: 0; text-align: left; font: inherit; font-size: 12px; line-height: 18px; color: var(--z-muted); cursor: pointer; }
  .process-icon { width: 16px; height: 16px; flex: 0 0 auto; }
  /* SVG ink, rather than its 16px box, should meet the label's optical center. */
  .process-icon[data-lucide="search"],
  .process-icon[data-lucide="squareTerminal"],
  .process-icon[data-lucide="circleQuestionMark"],
  .process-icon[data-lucide="codeXml"] { transform: translateY(-1px); }
  .process-icon[data-lucide="brain"] { transform: translateY(-1.5px); }
  /* Latin tool labels sit slightly above CJK labels in the VS Code UI font. */
  .raw-tool-head .process-icon[data-lucide="codeXml"] { transform: translateY(0); }
  .process-chevron { font-size: 14px; margin-left: auto; transform: translateY(-0.5px); }
  [aria-expanded="true"] > .process-chevron { transform: translateY(-0.5px) rotate(180deg); }
  .group-hidden, .work-note[hidden] { display: none; }
  .group-detail { margin-left: 24px; }
  .process-head:hover, .tool-head:hover { color: var(--vscode-foreground); }
  .process-head:focus-visible, .tool-head:focus-visible { outline: 1px solid var(--z-accent); outline-offset: -1px; border-radius: 4px; }
  .reasoning-head { margin-bottom: -6px; }
  .tool-status { font-size: 11px; }
  .tool-status.running { color: var(--z-accent); }
  .tool-status.completed, .tool-status.success { color: var(--z-muted); }
  .tool-status.error, .tool-status.failed { color: var(--z-danger-text); }
  .tool-io {
    margin-top: 4px; font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px; white-space: pre-wrap; max-height: 140px; overflow: auto;
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--vscode-foreground) 12%, transparent) transparent;
  }
  .file-change {
    margin-top: 8px;
    padding: 6px 8px;
    border-radius: 8px;
    background: var(--vscode-textCodeBlock-background, #111);
    font-size: 11px;
  }
  .file-path {
    background: none;
    border: 0;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    padding: 0;
    text-align: left;
    word-break: break-all;
  }
  .file-meta { opacity: .7; margin: 4px 0; }
  .file-actions { display: flex; gap: 6px; margin-top: 4px; }
  .file-actions button {
    background: transparent;
    color: inherit;
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 4px;
    padding: 2px 6px;
    font: inherit;
    font-size: 10px;
    cursor: pointer;
  }

  .perm-card, .ask-card {
    border: 1px solid color-mix(in srgb, var(--z-accent) 40%, var(--vscode-panel-border, #333));
    background: color-mix(in srgb, var(--vscode-editorWidget-background, #1e1e1e) 88%, var(--z-accent) 12%);
    border-radius: 10px;
    padding: 10px;
    font-size: 12px;
  }
  .perm-card.risk-high, .perm-card.risk-critical {
    border-color: color-mix(in srgb, var(--vscode-errorForeground, #f48771) 55%, transparent);
  }
  .perm-title { font-weight: 650; margin-bottom: 4px; }
  .perm-card, .ask-card { color: var(--vscode-editor-foreground, var(--vscode-foreground)); }
  .perm-reason, .perm-input, .ask-prompt, .ask-q {
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 4px 0;
    max-height: 140px;
    overflow: auto;
  }
  .perm-actions, .ask-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .perm-actions button, .ask-actions button {
    background: var(--vscode-button-secondaryBackground, #3a3a3a);
    color: var(--vscode-button-secondaryForeground, #ddd);
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 4px 8px;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
  }
  .perm-actions button.allow, .ask-actions button.accept {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .perm-actions button.deny, .ask-actions button.decline {
    color: var(--z-danger-text);
  }
  .perm-card.resolved, .ask-card.resolved { opacity: .7; }
  .perm-card.resolved button, .ask-card.resolved .ask-details button { pointer-events: none; }
  .ask-card.resolved { border:0; padding:0; background:transparent; opacity:1; }
  .ask-summary { width:100%; min-width:0; text-align:left; cursor:pointer; }
  .ask-details[hidden] { display:none; }
  .ask-card.resolved .ask-details { padding:8px 0 8px 24px; }
  .ask-card.resolved .ask-details button { opacity:.65; }

  .composer-head {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 8px 0;
    min-height: 22px;
  }
  .composer-head-left {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  #conn-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    padding-top: 2px;
    cursor: default;
  }
  #conn-label {
    font-size: 11px;
    color: var(--z-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .status-dot {
    width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
    background: var(--vscode-charts-green, #89d185);
  }
  .status-dot.idle { background: var(--vscode-charts-green, #89d185); }
  .status-dot.busy { background: var(--z-accent); animation: pulse 1.2s infinite; }
  .status-dot.error { background: var(--vscode-charts-red, #f48771); }
  .status-dot.warn { background: var(--z-warning); }
  @keyframes pulse { 50% { opacity: .35; } }

  #file-mentions { position:absolute; bottom:calc(100% - 10px); left:10px; right:10px; max-height:250px; overflow:auto; padding:6px; border:1px solid color-mix(in srgb, var(--vscode-foreground) 14%, transparent); border-radius:12px; background:color-mix(in srgb, var(--vscode-editor-background) 62%, transparent); box-shadow:0 16px 40px color-mix(in srgb, var(--vscode-widget-shadow, #000) 36%, transparent); backdrop-filter:var(--z-blur-sheet); -webkit-backdrop-filter:var(--z-blur-sheet); z-index:20; }
  html[data-frosted-glass="false"] #file-mentions { background:var(--vscode-editor-background); }
  #file-mentions[hidden] { display:none; }
  #slash-menu {
    display:none; position:absolute; bottom:calc(100% - 10px); left:10px; right:10px;
    max-height:260px; overflow:auto; padding:6px;
    border:1px solid color-mix(in srgb, var(--vscode-foreground) 14%, transparent); border-radius:12px;
    background:color-mix(in srgb, var(--vscode-editor-background) 62%, transparent);
    box-shadow:0 16px 40px color-mix(in srgb, var(--vscode-widget-shadow, #000) 36%, transparent);
    backdrop-filter:var(--z-blur-sheet); -webkit-backdrop-filter:var(--z-blur-sheet); z-index:20;
  }
  html[data-frosted-glass="false"] #slash-menu { background:var(--vscode-editor-background); }
  #slash-menu.open { display:block; }
  .slash-item {
    display:grid; grid-template-columns:auto auto 1fr; grid-template-rows:auto auto; column-gap:10px;
    width:100%; padding:6px 8px; border:0; border-radius:8px; background:transparent;
    color:var(--vscode-foreground); cursor:pointer; text-align:left;
  }
  .slash-item.active, .slash-item:hover { background:var(--vscode-list-hoverBackground); }
  .slash-icon { display:grid; place-items:center; width:15px; height:15px; color:var(--z-muted); align-self:center; }
  #active-command, #plan-indicator {
    display:inline-flex; align-items:center; gap:2px;
    color:var(--vscode-foreground); font-weight:600;
  }
  #active-command[hidden], #plan-indicator[hidden] { display:none; }
  #active-command svg, #plan-indicator svg { color:var(--z-accent); }
  #active-command .chip-icon, #active-command .chip-close,
  #plan-indicator .chip-icon, #plan-indicator .chip-close { display:grid; place-items:center; }
  #active-command .chip-close, #plan-indicator .chip-close { display:none; color:var(--z-muted); }
  #active-command:hover .chip-icon, #plan-indicator:hover .chip-icon { display:none; }
  #active-command:hover .chip-close, #plan-indicator:hover .chip-close { display:grid; color:var(--vscode-foreground); }
  .slash-name { font-size:12px; font-weight:600; align-self:center; white-space:nowrap; }
  .slash-hint { font-size:10px; color:var(--z-muted); align-self:center; text-align:right; }
  .slash-desc { grid-column:2 / -1; font-size:11px; color:var(--z-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .mention-heading,.mention-empty { color:var(--z-muted); font-size:12px; padding:6px 8px; }
  .mention-heading:not(:first-child) { margin-top:3px; border-top:1px solid color-mix(in srgb, var(--vscode-foreground) 9%, transparent); padding-top:8px; }
  #file-mentions button { font:inherit; display:flex; align-items:center; gap:8px; width:100%; padding:8px; border:0; border-radius:7px; background:transparent; color:var(--vscode-foreground); text-align:left; cursor:pointer; }
  #file-mentions button[aria-selected="true"],#file-mentions button:hover { background:var(--vscode-list-hoverBackground); }
  #file-mentions button span { flex-shrink:0; max-width:65%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #file-mentions small { color:var(--z-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #file-mentions button.mention-session { gap:8px; }
  #file-mentions .mention-session-icon { display:grid; place-items:center; flex:0 0 17px; width:17px; height:17px; color:var(--vscode-charts-blue, var(--z-accent)); }
  #file-mentions .mention-session-icon svg { display:block; width:16px; height:16px; }
  #file-mentions .mention-session-title { flex:1 1 auto; min-width:0; max-width:none; }
  #file-mentions .mention-session small { flex:0 1 auto; margin-left:auto; font-size:10px; }
  #file-mentions .mention-retry { width:auto; min-width:52px; margin:2px 8px 6px; padding:4px 9px; color:var(--z-accent); background:transparent; border:1px solid color-mix(in srgb, var(--z-accent) 32%, transparent); }
  #composer {
    --z-chrome-bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 10;
    padding: 14px 10px 10px;
    pointer-events: none;
    background: transparent;
    --composer-surface: color-mix(in srgb, var(--vscode-input-background) 78%, transparent);
    --composer-border: var(--vscode-input-border, var(--vscode-panel-border, transparent));
  }
  /* Opaque strip below the composer card — no transcript peeking past the bottom edge. */
  #composer::before {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 10px;
    z-index: 2;
    background: var(--z-chrome-bg);
    pointer-events: none;
  }
  /* Let scroll pass through gutters; only the floating cards capture input. */
  #composer > * { pointer-events: auto; }
  #question-rail, #usage-panel {
    background: var(--composer-surface);
    border: 1px solid var(--composer-border);
    border-radius: 10px;
    backdrop-filter: var(--z-blur);
    -webkit-backdrop-filter: var(--z-blur);
  }
  .composer-toggles {
    position: absolute;
    right: 8px;
    top: 0;
    z-index: 5;
    transform: translateY(-50%);
  }
  #rail-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 2px;
    width: 28px;
    height: 10px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: var(--composer-surface);
    color: var(--vscode-foreground);
    cursor: pointer;
  }
  #rail-toggle svg { display: block; flex-shrink: 0; }
  #rail-toggle .rail-symbol { width: 11px; height: 11px; }
  #rail-toggle .rail-chevron { width: 7px; height: 7px; }
  #rail-toggle.expand .rail-chevron { transform: rotate(180deg); }
  #rail-toggle[aria-expanded="true"] { color: var(--z-accent); }
  #rail-toggle:hover {
    color: var(--z-accent);
  }
  #rail-toggle[hidden] { display: none; }
  #usage-panel {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
    margin: 0;
    padding: 5px 8px;
    border-top: 0;
    border-radius: 0 0 12px 12px;
    color: var(--z-muted);
    font-size: 10px;
    line-height: 14px;
    font-variant-numeric: tabular-nums;
  }
  #usage-panel[hidden] { display: none; }
  .usage-cell { min-width: 0; }
  .usage-cell-head { display: flex; align-items: center; gap: 3px; white-space: nowrap; }
  .usage-cell-label { flex-shrink:0; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .usage-cell-detail { display:flex; justify-content:flex-end; align-items:center; gap:3px; flex:1; min-width:0; overflow:hidden; }
  .usage-cell-detail-text { min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .usage-context-symbol { flex-shrink:0; }
  .usage-cell-detail:empty { display:none; }
  .usage-cell-value { flex-shrink: 0; color: var(--vscode-foreground); }
  .usage-track { height: 5px; margin-top: 4px; border-radius: 3px; overflow: hidden; background: color-mix(in srgb, var(--vscode-foreground) 15%, transparent); }
  .usage-cell.money .usage-track { display: none; }
  .usage-cell.metric-only .usage-track { display: none; }
  .usage-cell.count-only .usage-track { display: none; }
  .usage-fill { height: 100%; background: var(--z-accent); border-radius: inherit; }
  .usage-cell.warm .usage-fill { background: var(--z-warning); }
  .usage-cell.hot { color: var(--z-danger-text); }
  .usage-cell.hot .usage-fill { background: var(--vscode-errorForeground, #f48771); }
  #question-rail {
    position: relative;
    height: 28px;
    margin: 0;
    padding: 0 36px 0 8px;
    border-bottom: 0;
    border-radius: 12px 12px 0 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  #question-rail[hidden] { display: none; }
  .question-rail-scroll {
    position: relative;
    flex: 1;
    min-width: 0;
    height: 100%;
    align-self: stretch;
  }
  #question-rail-track {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: stretch;
    gap: 0;
    overflow-x: auto;
    scrollbar-width: none;
    padding: 0 2px;
  }
  #question-rail.can-scroll #question-rail-track {
    /* Keep the last number clear of the edge fade at maximum scroll. */
    padding-right: 16px;
    -webkit-mask-image: linear-gradient(90deg, transparent, #000 12px, #000 calc(100% - 12px), transparent);
    mask-image: linear-gradient(90deg, transparent, #000 12px, #000 calc(100% - 12px), transparent);
  }
  #question-rail-track::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
  .q-dot {
    flex: 0 0 auto;
    min-width: 18px;
    width: auto;
    align-self: stretch;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 0;
    padding: 0 4px;
    background: transparent;
    color: color-mix(in srgb, var(--vscode-foreground) 58%, transparent);
    font-size: 9px;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    cursor: pointer;
  }
  .q-dot:hover,
  .q-dot:focus-visible { color: var(--vscode-foreground); }
  .q-dot.current { color: var(--z-accent); }
  .q-dot.current::after {
    content: "";
    position: absolute;
    inset: 6px 1px;
    border: 1px solid currentColor;
    border-radius: 4px;
    pointer-events: none;
  }
  .q-dot.mark { font-weight: 900; }
  .q-dot.mark:not(.current) {
    color: color-mix(in srgb, var(--vscode-foreground) 86%, transparent);
  }
  .q-dot.mark:hover,
  .q-dot.mark:focus-visible { color: var(--vscode-foreground); }
  #collapse-all-turns {
    position: absolute;
    right: 8px;
    top: 4px;
    z-index: 2;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 16px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
  }
  #collapse-all-turns svg { display: block; }
  #collapse-all-turns:hover,
  #collapse-all-turns:focus-visible { color: var(--z-accent); }
  .message.user.question-collapsed > .user-body {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    overflow: hidden;
  }
  .question-fold-btn svg { display: block; }
  .question-fold-btn:hover,
  .question-fold-btn:focus-visible {
    opacity: 1;
    color: var(--vscode-foreground);
    background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
  }
  .message.user.editing + .msg-meta .question-fold-btn { display: none; }
  #question-preview {
    position: absolute;
    bottom: calc(100% + 4px);
    width: max-content;
    max-width: min(260px, 100%);
    padding: 6px 8px;
    border-radius: 8px;
    background: var(--vscode-editorWidget-background, var(--vscode-input-background));
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
    box-shadow: var(--z-floating-shadow);
    font-size: 12px;
    line-height: 1.35;
    display: block;
    overflow: hidden;
    pointer-events: none;
    z-index: 7;
  }
  #question-preview[hidden] { display: none; }
  .question-preview-time {
    color: var(--vscode-descriptionForeground, var(--z-muted));
    font-size: 11px;
    line-height: 1.3;
    white-space: nowrap;
    margin-bottom: 2px;
  }
  .question-preview-time[hidden] { display: none; }
  .question-preview-body {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .message.user.jump-flash {
    box-shadow: 0 0 0 1px var(--vscode-focusBorder);
  }
  .history-more {
    align-self: center;
    margin: 2px auto 8px;
    border: 1px dashed color-mix(in srgb, var(--vscode-foreground) 35%, transparent);
    background: transparent;
    color: var(--vscode-foreground);
    border-radius: 999px;
    padding: 4px 12px;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
    opacity: .85;
  }
  .history-more:hover { opacity: 1; }
  .history-more:disabled { opacity: .55; cursor: default; }
  #popover {
    display: none;
    position: absolute;
    left: 8px;
    width: 220px;
    max-width: calc(100% - 16px);
    max-height: min(280px, 46vh);
    overflow: hidden;
    flex-direction: column;
    background: color-mix(in srgb, var(--vscode-editorWidget-background, var(--vscode-input-background)) 62%, transparent);
    border: 1px solid color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
    border-radius: 8px;
    box-shadow: 0 16px 40px color-mix(in srgb, var(--vscode-widget-shadow, #000) 36%, transparent);
    backdrop-filter: var(--z-blur-sheet);
    -webkit-backdrop-filter: var(--z-blur-sheet);
    z-index: 30;
    transform-origin: bottom left;
  }
  #popover.open {
    display: flex;
    animation: pop-up .14s ease-out;
  }
  @keyframes pop-up {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  #popover-list { overflow-y: auto; padding: 4px; }
  #popover .oi-title, #popover .oi-sub {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .composer-card {
    --composer-outline: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    background: var(--composer-surface);
    border: 1px solid var(--composer-outline);
    border-radius: 16px;
    box-shadow: 0 10px 28px color-mix(in srgb, var(--vscode-widget-shadow, #000) 34%, transparent);
    backdrop-filter: var(--z-blur);
    -webkit-backdrop-filter: var(--z-blur);
  }
  html[data-frosted-glass="false"] #composer { --composer-surface: var(--vscode-input-background); }
  html[data-frosted-glass="false"] #popover {
    background: var(--vscode-editorWidget-background, var(--vscode-input-background));
  }
  #composer:has(#question-rail:not([hidden])) .composer-card {
    border-top-left-radius: 0;
    border-top-right-radius: 0;
  }
  #composer:has(#usage-panel:not([hidden])) .composer-card {
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
  }
  .composer-card:focus-within {
    --composer-outline: color-mix(in srgb, var(--vscode-foreground) 28%, transparent);
  }
  .composer-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 6px 6px;
    min-height: 32px;
  }
  .toolbar-left {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }
  .toolbar-btn {
    display: inline-flex;
    align-items: center;
    flex: 0 1 auto;
    min-width: 20px;
    height: 28px;
    background: transparent;
    color: var(--z-muted);
    border: 0;
    border-radius: 8px;
    padding: 4px 5px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    max-width: 108px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .toolbar-btn.icon-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    padding: 0;
    font-size: 11px;
    font-weight: 650;
  }
  #mode-chip.icon-chip {
    flex: 0 0 22px;
    min-width: 22px;
    max-width: 22px;
  }
  #thought-chip.icon-chip {
    flex: 0 0 auto;
    width: auto;
    min-width: 22px;
    padding: 0 4px;
  }
  .toolbar-btn.icon-chip svg { width: 14px; height: 14px; }
  #mode-chip.icon-chip svg { width: 13px; height: 13px; }
  #controls-toggle {
    display: none;
    width: 14px;
    height: 28px;
    padding: 0;
    align-items: center;
    justify-content: center;
  }
  #controls-toggle svg { width: 7px; height: 7px; display: block; }
  html[data-fold-session-controls="true"] #controls-toggle { display: inline-flex; margin-left: -4px; }
  html[data-fold-session-controls="true"]:not([data-session-controls-open="true"]) #model-chip { padding-right: 2px; }
  html[data-session-controls-open="true"] #controls-toggle svg { transform: rotate(180deg); }
  html[data-fold-session-controls="true"]:not([data-session-controls-open="true"]) #mode-chip,
  html[data-fold-session-controls="true"]:not([data-session-controls-open="true"]) #thought-chip { display: none !important; }
  .oi-mode { display: flex; align-items: flex-start; gap: 8px; }
  .oi-mode > svg { width: 13px; height: 13px; margin-top: 1px; flex: 0 0 auto; }
  .thought-mark {
    display: inline-block;
    min-width: 1.6em;
    margin-right: 6px;
    font-size: 11px;
    font-weight: 650;
  }
  .toolbar-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,.08)); color: var(--vscode-foreground); }
  .toolbar-btn svg { color: var(--z-muted); }
  .context-meter {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    height: 28px;
    padding: 0 2px;
    border: 0;
    background: transparent;
    color: var(--z-accent-2);
    cursor: pointer;
    flex: 0 0 auto;
    border-radius: 4px;
  }
  .context-meter:hover { background: var(--vscode-toolbar-hoverBackground); }
  .context-meter .usage-chevron { width: 7px; height: 7px; margin: 0; }
  .usage-ring { display: inline-flex; }
  .usage-ring[hidden] { display: none; }
  .context-meter[aria-expanded="true"] .usage-chevron { transform: rotate(180deg); }
  .context-meter svg { width: 16px; height: 16px; display: block; margin: 1px; }
  .context-meter circle {
    fill: none;
    stroke-width: 2.4;
    transform: rotate(-90deg);
    transform-origin: 10px 10px;
  }
  .context-track { stroke: color-mix(in srgb, currentColor 22%, transparent); }
  .context-value,
  .five-hour-value {
    stroke: currentColor;
    stroke-linecap: round;
    stroke-dasharray: 43.98;
    stroke-dashoffset: 43.98;
  }
  .context-ring.warn,
  .five-hour-ring.warn { color: var(--z-warning); }
  .context-ring.hot,
  .five-hour-ring.hot { color: var(--vscode-charts-red, #f48771); }
  #image-drafts:empty { display:none; }
  #image-drafts, .user-images { display:flex; gap:6px; }
  /* Same join as the question rail, but painted behind the composer so the
     input and the dot-toggle stay clickable where they overlap. */
  #goal-zone {
    position: relative;
    z-index: 0;
    display: none;
    flex-direction: column;
    margin: 0 0 -1px;
    /* Leave the right edge clear of the question-rail toggle (28px, 8px from the card). */
    padding: 0 44px;
  }
  #goal-zone:has(#goal-strip:not([hidden])),
  #goal-zone:has(#queue-zone:not([hidden])) { display: flex; }
  #queue-zone {
    display:flex; flex-direction:column; width:100%; min-width:0;
    max-height:min(35vh, 240px); overflow-y:auto;
    margin:0;
    border:1px solid var(--composer-border, var(--vscode-panel-border, transparent));
    border-bottom:0;
    border-radius:12px 12px 0 0;
    background:var(--composer-surface, var(--vscode-input-background));
    box-shadow:none;
  }
  #goal-zone:has(#queue-zone:not([hidden])) #goal-strip {
    border-top-left-radius: 0;
    border-top-right-radius: 0;
  }
  #queue-zone[hidden] { display:none; }
  #queue-zone .message.queued {
    display:flex; align-items:center; gap:7px; width:100%; max-width:none;
    margin:0; padding:5px 8px; border:0; border-radius:0;
    background:transparent; box-shadow:none; color:var(--vscode-foreground);
  }
  #queue-zone .message.queued + .message.queued { border-top:1px solid var(--composer-border); }
  #queue-zone .queued-tag, #queue-zone .user-chips { display:none; }
  #queue-zone .user-images { order:1; flex:0 0 auto; flex-basis:auto; margin:0; flex-wrap:nowrap; }
  #queue-zone .user-images .image-chip { width:24px; height:24px; }
  #queue-zone .user-images .image-chip:not(:first-child) { display:none; }
  #queue-zone .user-body { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #queue-zone .queued-actions { margin:0; flex:0 0 auto; }
  #queue-zone .queued-actions button, #queue-zone .queue-grip {
    display:grid; place-items:center; width:24px; height:24px; padding:0;
    border:0; border-radius:5px; background:transparent; color:var(--z-muted); cursor:pointer;
  }
  #queue-zone .queued-actions button:hover, #queue-zone .queue-grip:hover { background:var(--vscode-toolbar-hoverBackground); color:var(--vscode-foreground); }
  #queue-zone .queued-actions svg, #queue-zone .queue-grip svg { width:15px; height:15px; }
  #queue-zone .queued-edit { flex:1; width:auto; min-width:0; min-height:32px; margin:0; }
  #queue-zone .queued-edit + .queued-actions button { width:auto; min-width:32px; padding:0 5px; }
  #queue-zone .message.queued.queue-drop-before { box-shadow:inset 0 2px var(--z-accent); }
  #queue-zone .message.queued.queue-drop-after { box-shadow:inset 0 -2px var(--z-accent); }
  #queue-zone .message.queued.queue-dragging { opacity:.5; }
  #goal-strip {
    display:flex; align-items:center; gap:6px;
    width: 100%;
    min-width: 0;
    min-height:30px; padding:4px 10px 3px 12px;
    border:1px solid var(--composer-border, var(--vscode-panel-border, transparent));
    border-bottom: 0;
    border-radius: 12px 12px 0 0;
    background:var(--composer-surface, var(--vscode-input-background));
    box-shadow: none;
    font-size:13px; color:var(--vscode-foreground);
  }
  #goal-strip[hidden] { display:none; }
  #goal-strip .goal-strip-icon { display:grid; place-items:center; color:var(--z-muted); flex:0 0 auto; }
  #goal-strip .goal-strip-icon svg { width:15px; height:15px; }
  #goal-status-text { flex:0 0 auto; font-weight:650; white-space:nowrap; }
  #goal-objective { flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--vscode-foreground); }
  #goal-strip.expanded #goal-objective { white-space:normal; }
  #goal-timer { flex:0 0 auto; color:var(--z-muted); white-space:nowrap; }
  #goal-actions { display:inline-flex; align-items:center; gap:2px; flex:0 0 auto; margin-left:auto; }
  #goal-actions button {
    display:grid; place-items:center; width:26px; height:26px; padding:0;
    border:0; border-radius:6px; background:transparent; color:var(--z-muted); cursor:pointer;
  }
  #goal-actions button:hover { background:var(--vscode-toolbar-hoverBackground); color:var(--vscode-foreground); }
  #goal-actions button:disabled { opacity:.4; cursor:default; }
  #goal-actions button:disabled:hover { background:transparent; color:var(--z-muted); }
  #image-drafts { overflow-x:auto; padding:6px 10px 2px; }
  .user-images { flex-wrap:wrap; margin-bottom:6px; }
  #attach-files { display:grid; place-items:center; flex:0 0 24px; width:24px; height:24px; padding:0; margin-top:-1px; }
  .image-chip { position:relative; display:flex; flex:0 0 auto; width:64px; height:64px; padding:0; border:1px solid var(--vscode-panel-border); border-radius:9px; overflow:hidden; color:var(--z-muted); background:var(--vscode-editor-background); }
  .image-chip img { width:100%; height:100%; object-fit:cover; }
  .image-name { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
  .image-chip[data-status="error"] { border-color:var(--z-danger-text); color:var(--z-danger-text); }
  .image-chip[data-status="uploading"] .image-preview-btn { opacity:.55; }
  .image-chip .image-preview-btn, button.image-chip { display:flex; align-items:center; justify-content:center; cursor:pointer; }
  .image-chip .image-preview-btn { width:100%; height:100%; padding:0; border:0; border-radius:inherit; background:none; color:inherit; }
  .image-chip .image-preview-btn:disabled { cursor:default; }
  .image-chip .image-remove { position:absolute; top:3px; right:3px; display:grid; place-items:center; width:18px; height:18px; padding:0; border:1px solid var(--vscode-panel-border); border-radius:50%; background:var(--vscode-editor-background); color:var(--vscode-foreground); cursor:pointer; }
  .image-chip .image-remove:hover { background:var(--vscode-toolbar-hoverBackground); }
  .image-chip:has(:focus-visible), button.image-chip:focus-visible { outline:1px solid var(--z-accent); outline-offset:1px; }
  .user-images .image-chip { width:80px; height:80px; }
  .user-images { flex-basis:100%; }
  .cmd-chip {
    display:inline-flex; align-items:center; gap:2px; margin-bottom:5px;
    padding:3px 10px 3px 7px; border-radius:8px;
    background:color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
    color:var(--vscode-input-foreground, var(--vscode-foreground));
    font-size:12px; font-weight:600; letter-spacing:.2px;
  }
  .cmd-chip svg { flex:0 0 auto; }
  /* Nudge the capsule down onto the CJK baseline so the label sits level with
     the body text instead of floating on middle alignment. */
  .cmd-chip.inline { margin:0 3px 0 0; vertical-align:-1px; }
  .timeline-mark {
    display:flex; align-items:center; justify-content:center; gap:7px; margin:6px 0;
    font-size:11.5px; color:var(--z-muted); user-select:none;
  }
  .timeline-mark::before {
    content:""; flex:1 1 20px; height:1px; min-width:24px;
    background:linear-gradient(to left, color-mix(in srgb, currentColor 35%, transparent), transparent);
  }
  .timeline-mark .timeline-icon { flex:0 0 auto; }
  .timeline-mark span { flex:0 1 auto; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .model-mark > .model-mark-label {
    display:flex; flex:0 1 auto; flex-wrap:wrap; align-items:baseline; justify-content:center;
    min-width:0; max-width:calc(100% - 48px); gap:1px 4px;
    white-space:normal; overflow:visible; text-overflow:clip; text-align:center; line-height:1.4;
  }
  .model-mark .model-mark-prefix, .model-mark .model-mark-arrow { flex:0 0 auto; }
  .model-mark .model-mark-name {
    flex:0 1 auto; min-width:0; max-width:100%;
    white-space:normal; overflow:visible; overflow-wrap:anywhere; text-overflow:clip;
  }
  .timeline-mark::after {
    content:""; flex:1 1 20px; height:1px; min-width:24px;
    background:linear-gradient(to right, color-mix(in srgb, currentColor 35%, transparent), transparent);
  }
  .model-mark::before, .model-mark::after { flex:0 1 16px; min-width:8px; max-width:16px; }
  .goal-mark.passed { color:var(--vscode-charts-green, var(--z-accent)); }
  .compact-mark.running { color:var(--z-accent); }
  .compact-mark.running .timeline-icon { animation: compact-pulse 1.2s ease-in-out infinite; }
  @keyframes compact-pulse { 50% { opacity: 0.45; } }
  .compact-mark.failed { color:var(--z-danger-text, var(--vscode-errorForeground)); }
  /* Plan document card: readable Markdown, not a raw tool JSON dump. */
  .plan-card {
    display:flex; flex-direction:column; gap:6px;
    padding:10px 12px; border-radius:10px;
    border:1px solid color-mix(in srgb, var(--z-accent) 28%, transparent);
    background:color-mix(in srgb, var(--z-accent) 5%, transparent);
  }
  .plan-head { display:flex; align-items:center; gap:7px; color:var(--z-accent); }
  .plan-title { font-size:12px; font-weight:600; color:var(--vscode-foreground); }
  .plan-open {
    margin-left:auto; border:0; background:transparent; padding:0 2px;
    color:var(--z-accent); font:inherit; font-size:11px; cursor:pointer;
  }
  .plan-open:hover { text-decoration:underline; }
  .plan-status { margin-left:8px; font-size:10.5px; padding:1px 8px; border-radius:999px; }
  .plan-status.waiting { color:var(--z-accent); background:color-mix(in srgb, var(--z-accent) 12%, transparent); }
  .plan-status.approved { color:var(--vscode-charts-green, var(--z-accent)); background:color-mix(in srgb, var(--vscode-charts-green, var(--z-accent)) 12%, transparent); }
  .plan-status.rejected { color:var(--z-danger-text, var(--vscode-errorForeground)); background:color-mix(in srgb, var(--z-danger-text, var(--vscode-errorForeground)) 12%, transparent); }
  .plan-body { font-size:12px; }
  .plan-body .md :first-child { margin-top:0; }
  .plan-body .md :last-child { margin-bottom:0; }
  .plan-raw { white-space:pre-wrap; word-break:break-word; color:var(--z-muted); }
  .plan-prompts { border-top:1px dashed color-mix(in srgb, var(--vscode-foreground) 15%, transparent); padding-top:6px; font-size:11px; color:var(--z-muted); }
  .plan-prompt { padding:1px 0 1px 12px; position:relative; }
  .plan-prompt::before { content:""; position:absolute; left:2px; top:50%; width:4px; height:4px; border-radius:50%; background:currentColor; transform:translateY(-50%); }
  .goal-mark.failed { color:var(--z-danger-text, var(--vscode-errorForeground)); }
  .user-images[data-editing="1"] .image-chip[data-removed="1"] { opacity:.4; }
  .user-images[data-editing="1"] .image-chip[data-removed="1"] .image-remove { color:var(--z-accent); }
  #image-preview { position:fixed; top:0; right:0; bottom:0; left:0; z-index:200; background:var(--vscode-editor-background); display:flex; align-items:center; justify-content:center; padding:32px; }
  #image-preview img { max-width:100%; max-height:100%; object-fit:contain; cursor:zoom-in; user-select:none; transform-origin:center center; }
  #image-preview img.pannable { cursor:grab; }
  #image-preview img.pannable:active { cursor:grabbing; }
  #image-preview .image-zoom {
    position:absolute; left:50%; bottom:18px; transform:translateX(-50%);
    display:flex; align-items:center; gap:2px; padding:4px;
    background:color-mix(in srgb, var(--vscode-editorWidget-background) 92%, transparent);
    border:1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
    border-radius:999px; box-shadow:var(--z-floating-shadow); backdrop-filter:blur(6px);
  }
  #image-preview .image-zoom button {
    display:grid; place-items:center; width:26px; height:26px; padding:0;
    border:0; border-radius:50%; background:transparent; color:var(--vscode-foreground); cursor:pointer;
  }
  #image-preview .image-zoom button:hover { background:var(--vscode-toolbar-hoverBackground); }
  #image-preview .image-zoom button.image-zoom-fit {
    width:auto; min-width:0; flex:0 0 auto; display:inline-flex; align-items:center;
    padding:0 10px; border-radius:999px; font-size:11px; white-space:nowrap;
  }
  #image-preview .image-zoom .image-zoom-label {
    min-width:52px; text-align:center; font-size:11px; font-variant-numeric:tabular-nums;
    color:var(--z-muted, var(--vscode-foreground)); user-select:none;
  }
  #image-preview > button { position:absolute; right:12px; top:12px; }
  #attachments, #editor-chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  #attachments:empty, #editor-chip-row:empty { display: none; }
  .ctx-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
    border-radius: 4px;
    font-size: 11px;
    max-width: 100%;
  }
  .ctx-chip.session-ref-chip { border-color:color-mix(in srgb, var(--vscode-charts-blue, var(--z-accent)) 28%, var(--vscode-editorWidget-border, var(--vscode-panel-border))); }
  .session-ref-icon { display:block; flex:0 0 13px; width:13px; height:13px; color:var(--vscode-charts-blue, var(--z-accent)); }
  .session-ref-chip > span { max-width:220px; }
  .ctx-chip span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 220px;
  }
  .ctx-chip.implicit { opacity: .9; cursor: pointer; }
  .ctx-chip.hidden {
    opacity: .45;
    background: transparent;
    text-decoration: line-through;
    text-decoration-color: color-mix(in srgb, var(--vscode-foreground) 35%, transparent);
  }
  .ctx-chip button {
    background: transparent;
    border: 0;
    color: inherit;
    cursor: pointer;
    font: inherit;
    padding: 0 0 0 2px;
    opacity: .6;
  }
  .ctx-chip button:hover { opacity: 1; }
  .user-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
  #input-area {
    position: relative;
    display: flex; gap: 8px; align-items: flex-end;
  }
  #input-area > .soft-scroll.y { top: 8px; right: 2px; bottom: 4px; }
  #input {
    flex: 1; resize: none; min-height: 40px; max-height: 160px;
    padding: 8px 10px 4px;
    border: 0; border-radius: 12px 12px 0 0;
    background: transparent;
    overflow-y: auto; overflow-x: hidden; scrollbar-width: none;
    color: var(--vscode-input-foreground);
    font: inherit; line-height: 1.4;
  }
  #input::placeholder { color:color-mix(in srgb, var(--vscode-input-placeholderForeground, var(--z-muted)) 94%, var(--vscode-input-foreground, var(--vscode-foreground)) 6%); opacity:1; }
  #input::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
  body.vscode-high-contrast #input::placeholder, body.vscode-high-contrast-light #input::placeholder { color:var(--vscode-input-placeholderForeground, var(--z-muted)); }
  #input:focus { outline: none; }
  #overlay-search:focus-visible, #ui-language:focus-visible, .queued-edit:focus-visible, .user-edit:focus-visible {
    outline: 1px solid var(--z-accent);
    outline-offset: 1px;
  }
  .send {
    width: 28px; height: 28px;
    border: 0; border-radius: 50%;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    display: inline-flex; align-items: center; justify-content: center;
    cursor: pointer; flex-shrink: 0; padding: 0;
  }
  .send svg { width: 14px; height: 14px; }
  .send:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .send:active:not(:disabled) { opacity: .85; }
  .send:focus-visible, .icon-btn:focus-visible, .toolbar-btn:focus-visible,
  .context-meter:focus-visible, #rail-toggle:focus-visible, #collapse-all-turns:focus-visible {
    outline: 1px solid var(--z-accent);
    outline-offset: 2px;
  }
  .toolbar-btn:focus-visible { outline-offset: -2px; }
  .send[hidden] { display: none; }
  .send:disabled { opacity: .5; cursor: default; }
  #insert-now-btn { display: none; }
  #insert-now-btn.show { display: inline-flex; }
  .queued-tag {
    font-size: 10px;
    margin-bottom: 4px;
    color: var(--z-muted);
  }
  .queued-actions { display: flex; gap: 4px; margin-top: 6px; }
  .queued-actions button {
    background: transparent;
    color: inherit;
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 4px;
    padding: 2px 6px;
    font: inherit;
    font-size: 10px;
    cursor: pointer;
  }
  .queued-actions button:hover { background: var(--vscode-toolbar-hoverBackground); }
  .queued-edit, .user-edit {
    width: 100%;
    min-height: 48px;
    margin-top: 4px;
    padding: 6px;
    font: inherit;
    color: inherit;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-focusBorder);
    border-radius: 6px;
    resize: vertical;
    white-space: pre-wrap;
  }
  .user-edit { display:block; min-height:64px; line-height:1.5; }
  .tool-section-label { margin:8px 0 4px; font-size:11px; color:var(--z-muted); }
  .user-actions {
    display:flex; align-items:center; justify-content:space-between; flex-wrap:nowrap;
    gap:8px; min-height:30px; margin-top:8px;
  }
  .user-edit-action-group { display:inline-flex; align-items:center; flex:0 0 auto; gap:2px; }
  .user-actions button { flex:0 0 auto; white-space:nowrap; }
  .user-actions button, .git-rewind, .git-file button, .git-confirm button {
    background: transparent;
    color: inherit;
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 4px;
    padding: 2px 6px;
    font: inherit;
    font-size: 10px;
    cursor: pointer;
  }
  .user-actions .user-edit-action {
    display:grid; place-items:center; width:28px; height:28px; padding:0;
    border:0; border-radius:8px; background:transparent;
    color:var(--z-muted); cursor:pointer;
  }
  .user-actions .user-edit-action svg { display:block; width:15px; height:15px; }
  .user-actions .edit-add-image svg { width:16px; height:16px; }
  .user-actions .user-edit-action:hover {
    background:var(--vscode-toolbar-hoverBackground); color:var(--vscode-foreground);
  }
  .user-actions .user-edit-action:focus-visible {
    outline:1px solid var(--z-accent); outline-offset:1px;
  }
  .user-actions .user-edit-send {
    width:28px; height:28px; border-radius:50%;
    background:var(--vscode-button-background); color:var(--vscode-button-foreground);
  }
  .user-actions .user-edit-send:hover {
    background:var(--vscode-button-hoverBackground); color:var(--vscode-button-foreground);
  }
  .user-actions .user-edit-send svg { width:14px; height:14px; }
  .user-actions button:hover, .git-rewind:hover, .git-file button:hover, .git-confirm button:hover { background: var(--vscode-toolbar-hoverBackground); }
  .git-changes {
    border: 1px solid var(--vscode-panel-border, #333);
    border-radius: 8px;
    background: var(--vscode-textCodeBlock-background, #111);
    font-size: 12px;
  }
  .git-bar { display: flex; align-items: center; gap: 6px; padding: 4px 6px 4px 4px; }
  .git-head {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    padding: 2px;
  }
  .git-chevron {
    flex: 0 0 auto;
    width: 0; height: 0;
    border-style: solid;
    border-width: 4px 0 4px 6px;
    border-color: transparent transparent transparent currentColor;
    opacity: .7;
  }
  .git-changes.open .git-chevron { transform: rotate(90deg); }
  .git-title { font-weight: 600; min-width: 0; }
  .git-stat { display: inline-flex; gap: 6px; font-variant-numeric: tabular-nums; font-size: 11px; }
  .git-add { color: var(--vscode-gitDecoration-addedResourceForeground, #89d185); }
  .git-del { color: var(--vscode-gitDecoration-deletedResourceForeground, #f48771); }
  .git-reverted {
    font-size: 10px;
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 4px;
    padding: 0 4px;
    color: var(--z-muted);
  }
  .git-body { border-top: 1px solid var(--vscode-panel-border, #333); }
  .git-body[hidden] { display: none; }
  .git-file {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    min-width: 0;
  }
  .git-file .file-path {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .git-file .git-stat, .git-file [data-git-review] { flex: 0 0 auto; }
  .file-previews { display:grid; gap:6px; margin:12px 0 2px; }
  .file-preview-card {
    display:flex; align-items:center; gap:10px; width:100%; min-width:0;
    padding:8px 10px; border:1px solid var(--vscode-panel-border, #555);
    border-radius:9px; background:var(--vscode-textCodeBlock-background, transparent);
    color:var(--vscode-foreground); font:inherit; text-align:left; cursor:pointer;
  }
  .file-preview-card:hover { background:var(--vscode-list-hoverBackground); }
  .file-preview-card:focus-visible { outline:1px solid var(--vscode-focusBorder); outline-offset:2px; }
  .file-preview-icon {
    display:grid; place-items:center; flex:0 0 34px; width:34px; height:34px;
    border-radius:6px; background:color-mix(in srgb, var(--vscode-foreground) 7%, transparent);
    color:var(--vscode-textLink-foreground);
  }
  .file-preview-icon svg { width:18px; height:18px; }
  .file-preview-copy { display:grid; gap:1px; flex:1; min-width:0; }
  .file-preview-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
  .file-preview-subtitle { color:var(--z-muted); font-size:11px; line-height:1.3; }
  .file-preview-open {
    flex:0 0 auto; border:1px solid var(--vscode-panel-border, #555);
    border-radius:6px; padding:2px 7px; color:var(--z-muted); font-size:11px;
  }
  .git-loading, .git-confirm {
    padding: 6px 8px;
    font-size: 11px;
    color: var(--z-muted);
  }
  .git-confirm { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }

  #overlay, #setup {
    display: none; position: absolute; top: 0; right: 0; bottom: 0; left: 0;
    z-index: 40;
    padding: 18px 12px 24px;
  }
  /* No full-screen scrim. Only the session sheet is glass; the rest of
     the overlay is a click target so the transcript stays sharp. */
  #overlay { background: transparent; }
  #setup {
    background: color-mix(in srgb, var(--vscode-editor-background) 72%, black);
  }
  #overlay .sheet {
    background: color-mix(in srgb, var(--vscode-editorWidget-background, var(--vscode-editor-background)) 62%, transparent);
    border-color: color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
    box-shadow: 0 16px 40px color-mix(in srgb, var(--vscode-widget-shadow, #000) 36%, transparent);
    backdrop-filter: var(--z-blur-sheet);
    -webkit-backdrop-filter: var(--z-blur-sheet);
  }
  html[data-frosted-glass="false"] #overlay .sheet {
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  #overlay.open, #setup.open { display: block; }
  .sheet {
    max-width: 420px; margin: 0 auto;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
    border-radius: 12px;
    box-shadow: var(--z-floating-shadow);
    overflow: hidden;
    display: flex; flex-direction: column;
    max-height: 100%;
  }
  .sheet-head {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 10px 6px;
    font-weight: 650; font-size: 12px;
  }
  .sheet-head span { flex: 1; }
  .session-tabs {
    display: none;
    gap: 6px;
    padding: 0 10px 8px;
  }
  .session-tabs.show { display: flex; }
  .tab-btn {
    flex: 1;
    background: transparent;
    color: inherit;
    border: 1px solid var(--vscode-panel-border, #333);
    border-radius: 6px;
    padding: 4px 8px;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
    color: var(--z-muted);
  }
  .tab-btn.active {
    opacity: 1;
    border-color: var(--z-accent);
    color: var(--z-accent);
  }
  .oi-row { display: flex; align-items: flex-start; gap: 6px; }
  .oi-main { flex: 1; min-width: 0; }
  .oi-actions { display: flex; gap: 4px; flex-shrink: 0; }
  .oi-actions button {
    position: relative;
    background: transparent;
    color: inherit;
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 4px;
    padding: 2px 6px;
    font: inherit;
    font-size: 10px;
    cursor: pointer;
  }
  .oi-actions button:disabled:not([data-pending]) { opacity: .55; cursor: default; }
  .oi-actions button[data-pending="1"] { cursor: progress; }
  .oi-actions button[data-pending="1"] .session-action-label { visibility: hidden; }
  .session-action-dots { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 3px; pointer-events: none; }
  .session-action-dots[hidden] { display: none; }
  .session-action-dots i { width: 3px; height: 3px; border-radius: 50%; background: currentColor; opacity: .25; animation: session-action-dot 900ms ease-in-out infinite; }
  .session-action-dots i:nth-child(2) { animation-delay: 140ms; }
  .session-action-dots i:nth-child(3) { animation-delay: 280ms; }
  @keyframes session-action-dot { 0%, 80%, 100% { opacity: .25; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2px); } }
  @media (prefers-reduced-motion: reduce) { .session-action-dots i { animation: none; opacity: .7; } }
  .oi-actions button:hover { background: var(--vscode-toolbar-hoverBackground); }
  .oi-actions button:disabled:hover { background: transparent; }
  .oi-actions button.danger { color: var(--z-danger-text); }
  #overlay-search {
    margin: 0 10px 8px;
    padding: 6px 8px; border-radius: 6px;
    border: 1px solid var(--vscode-input-border, transparent);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font: inherit;
  }
  #overlay-list, #setup-list { overflow-y: auto; padding: 4px 6px 10px; }
  .overlay-group {
    padding: 10px 10px 4px;
    font-size: 10px;
    letter-spacing: .06em;
    text-transform: uppercase;
    font-weight: 650;
    color: var(--z-muted);
  }
  .overlay-item {
    display: block; width: 100%; text-align: left;
    background: transparent; color: inherit; border: 0;
    padding: 8px 10px; border-radius: 8px; cursor: pointer; font: inherit;
  }
  .overlay-item:hover { background: var(--vscode-list-hoverBackground); }
  .overlay-item.active { outline: 1px solid var(--z-accent); }
  .overlay-item.disabled { opacity: .45; cursor: not-allowed; }
  .oi-title { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; }
  .oi-live {
    flex: 0 0 auto;
    padding: 0 6px;
    border-radius: 999px;
    font-size: 10px;
    line-height: 16px;
    color: var(--vscode-foreground);
    background: color-mix(in srgb, var(--z-accent) 12%, transparent);
  }
  .oi-sub { font-size: 11px; color: var(--z-muted); margin-top: 2px; }
  .overlay-empty { padding: 16px; color: var(--z-muted); font-size: 12px; }
  #setup-recovery { padding:0 12px 10px; }
  #setup-hint { padding: 0 12px 8px; font-size: 12px; color: var(--z-muted); line-height: 1.4; }

  #toast {
    position: absolute; bottom: 64px; left: 50%; transform: translateX(-50%) translateY(8px);
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-panel-border);
    padding: 6px 10px; border-radius: 999px; font-size: 11px;
    opacity: 0; pointer-events: none; transition: opacity .15s, transform .15s;
    /* Above the session overlay (z 5) and pickers (z 30): guidance fired from
       inside those layers must stay visible, e.g. the archived-session hint. */
    z-index: 300;
  }
  #toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  #tooltip {
    position: fixed; z-index: 120; max-width: 300px; padding: 6px 10px;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
    border-radius: 8px; box-shadow: var(--z-floating-shadow);
    font-size: 11px; line-height: 1.55; color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
    pointer-events: none; opacity: 0; transform: translateY(3px);
    transition: opacity .12s ease-out, transform .12s ease-out;
    overflow-wrap: anywhere;
  }
  #tooltip.show { opacity: 1; transform: translateY(0); }
  #tooltip div + div { margin-top: 2px; }
  #tooltip .tip-label { font-weight: 650; }
  #jump-latest {
    display: none;
    position: absolute;
    left: 50%;
    top: -8px;
    transform: translate(-50%, -100%);
    z-index: 4;
    background: var(--vscode-editorWidget-background);
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
    border-radius: 999px;
    padding: 0;
    width: 28px; height: 28px;
    cursor: pointer;
    box-shadow: var(--z-floating-shadow);
  }
  #composer:has(#pending-action:not([hidden])) #jump-latest { left: 16px; transform: translateY(-100%); }
  #jump-latest.show { display: inline-flex; align-items: center; justify-content: center; }
  #overlay-close, #setup-close { background: transparent; color: var(--z-muted); padding: 0; }

  /* Match the conversation custom rail: hairline, low-contrast, no buttons. */
  ::-webkit-scrollbar {
    width: 2px !important;
    height: 2px !important;
  }
  ::-webkit-scrollbar-button {
    display: none !important;
    width: 0 !important;
    height: 0 !important;
  }
  ::-webkit-scrollbar-track {
    background: transparent !important;
  }
  ::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent) !important;
    border-radius: 999px;
    border: 0 !important;
    box-shadow: none !important;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: color-mix(in srgb, var(--vscode-foreground) 48%, transparent) !important;
  }
  ::-webkit-scrollbar-thumb:active {
    background: color-mix(in srgb, var(--vscode-foreground) 28%, transparent) !important;
  }
  ::-webkit-scrollbar-corner { background: transparent !important; }
</style>
</head>
<body>
  <div id="topbar">
    <input id="session-title" type="text" value="${t("新会话")}" spellcheck="false" title="${t("点击重命名")}" aria-label="${t("会话名称")}">
    <button class="icon-btn" id="btn-sessions" title="${t("历史会话")}" aria-label="${t("历史会话")}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></svg>
    </button>
    <button class="icon-btn" id="btn-new" title="${t("新会话")}" aria-label="${t("新会话")}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" /></svg>
    </button>
    <button type="button" class="icon-btn" id="btn-settings" title="${t("设置")}" aria-label="${t("设置")}" aria-haspopup="dialog" aria-expanded="false">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>
    </button>
    <div id="settings-menu" role="dialog" aria-label="${t("设置")}" hidden>
        <div class="settings-section">${t("新会话默认值")}</div>
        <div class="settings-select-group">
          <label class="settings-select-label" for="default-session-model">${t("模型")}</label>
          <select class="settings-select" id="default-session-model" aria-label="${t("新会话默认模型")}">
            <option value="desktop">${t("跟随 ZCode 默认")}</option>
          </select>
        </div>
        <div class="settings-select-group">
          <label class="settings-select-label" for="default-session-mode">${t("权限")}</label>
          <select class="settings-select" id="default-session-mode" aria-label="${t("新会话默认权限")}">
            <option value="desktop">${t("跟随 ZCode 默认")}</option>
            <option value="build">${t("变更前确认")}</option>
            <option value="edit">${t("自动编辑")}</option>
            <option value="plan">${t("计划模式")}</option>
            <option value="yolo">${t("完全访问")}</option>
          </select>
        </div>
        <div class="settings-select-group">
          <label class="settings-select-label" for="default-session-thought">${t("思考强度")}</label>
          <select class="settings-select" id="default-session-thought" aria-label="${t("新会话默认思考强度")}">
            <option value="desktop">${t("跟随模型默认")}</option>
          </select>
        </div>
        <div class="settings-help" id="new-session-thought-help">${t("思考强度取决于模型；更换默认模型后会恢复为模型默认值。")}</div>
        <div class="settings-section">${t("界面")}</div>
        <label class="settings-switch"><span>${t("毛玻璃效果")}</span><span class="switch"><input type="checkbox" id="frosted-glass" data-chrome="frostedGlass"${chrome.frostedGlass ? " checked" : ""}><i></i></span></label>
        <div class="settings-item">
          <label id="language-label" for="ui-language">${t("界面语言")}</label>
          <select id="ui-language" aria-labelledby="language-label">
            <option value="auto">${t("跟随 VS Code")}</option>
            <option value="zh-CN">简体中文</option>
            <option value="zh-TW">繁體中文</option>
            <option value="en">English</option>
          </select>
        </div>
        <button type="button" class="settings-action" id="copy-diagnostics">${t("复制诊断信息")}</button>
        <div class="settings-section">${t("问题跳转")}</div>
        <label class="settings-switch"><span>${t("显示问题跳转按钮")}</span><span class="switch"><input type="checkbox" id="show-question-jump" data-chrome="showQuestionJump"${chrome.showQuestionJump ? " checked" : ""}><i></i></span></label>
        <div class="settings-section">${t("额度")}</div>
        <label class="settings-switch"><span>${t("允许展开额度窗口")}</span><span class="switch"><input type="checkbox" id="show-usage-chevron" data-chrome="showUsageChevron"${chrome.showUsageChevron ? " checked" : ""}><i></i></span></label>
        <label class="settings-switch"><span>${t("显示上下文圆圈")}</span><span class="switch"><input type="checkbox" id="show-context-ring" data-chrome="showContextRing"${chrome.showContextRing ? " checked" : ""}><i></i></span></label>
        <label class="settings-switch"><span>${t("显示 5 小时限额圆圈")}</span><span class="switch"><input type="checkbox" id="show-five-hour-ring" data-chrome="showFiveHourRing"${chrome.showFiveHourRing ? " checked" : ""}><i></i></span></label>
        <div class="settings-section">${t("输入区")}</div>
        <label class="settings-switch"><span>${t("显示连接状态")}</span><span class="switch"><input type="checkbox" id="show-connection-status" data-chrome="showConnectionStatus"${chrome.showConnectionStatus ? " checked" : ""}><i></i></span></label>
        <label class="settings-switch"><span>${t("权限和推理显示为图标")}</span><span class="switch"><input type="checkbox" id="session-controls-icons" data-chrome="sessionControlsIcons"${chrome.sessionControlsIcons ? " checked" : ""}><i></i></span></label>
        <label class="settings-switch"><span>${t("折叠权限和推理")}</span><span class="switch"><input type="checkbox" id="fold-session-controls" data-chrome="foldSessionControls"${chrome.foldSessionControls ? " checked" : ""}><i></i></span></label>
    </div>
  </div>
  <div id="messages"></div>
  <div id="messages-scrollbar" hidden aria-hidden="true"><div id="messages-thumb"></div></div>
  <div id="composer">
    <div id="goal-zone">
      <div id="queue-zone" hidden aria-label="${t("排队中，当前回复结束后发送")}"></div>
      <div id="goal-strip" hidden>
        <span class="goal-strip-icon" aria-hidden="true"></span>
        <span id="goal-status-text"></span>
        <span id="goal-objective"></span>
        <span id="goal-timer"></span>
        <span id="goal-actions">
          <button type="button" id="goal-clear" aria-label="${t("清除目标")}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg></button>
          <button type="button" id="goal-pause" aria-label="${t("暂停目标")}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/></svg></button>
          <button type="button" id="goal-expand" aria-expanded="false" aria-label="${t("展开目标")}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M21 3l-7 7"/><path d="M9 21H3v-6"/><path d="M3 21l7-7"/></svg></button>
        </span>
      </div>
    </div>
    <div id="slash-menu" role="listbox"></div>
    <button type="button" id="pending-action" hidden aria-live="polite">${t("查看待处理请求")}</button>
    <button type="button" id="jump-latest" title="${t("回到底部")}" aria-label="${t("回到底部")}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v16m-6-6 6 6 6-6"/></svg></button>
    <div id="question-rail" hidden>
      <div id="question-preview" hidden><div class="question-preview-time" hidden></div><div class="question-preview-body"></div></div>
      <div class="question-rail-scroll"><div id="question-rail-track"></div></div>
      <button type="button" id="collapse-all-turns" title="${t("折叠所有对话")}" aria-label="${t("折叠所有对话")}"><svg width="12" height="10" viewBox="0 0 12 10" fill="none" aria-hidden="true"><path d="M1 1.5h10M1 5h10M1 8.5h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>
    </div>
    <div id="popover"><div id="popover-list"></div></div>
    <div class="composer-card">
      <div class="composer-toggles">
        <button type="button" id="rail-toggle" hidden title="${t("展开问题跳转")}" aria-label="${t("展开问题跳转")}" aria-expanded="false" aria-controls="question-rail">
          <svg class="rail-symbol" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><circle cx="2" cy="6" r="1"/><circle cx="6" cy="6" r="1"/><circle cx="10" cy="6" r="1"/></svg><svg class="rail-chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 7.5 6 4l3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <div class="composer-head">
        <button type="button" id="attach-files" class="toolbar-btn" title="${t("添加图片或文件")}" aria-label="${t("添加图片或文件")}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <div class="composer-head-left">
          <div id="attachments"></div>
          <div id="editor-chip-row"></div>
        </div>
        <div id="conn-status" title="${t("连接中")}">
          <span id="conn-label" role="status" aria-live="polite">${t("连接中")}</span>
          <span class="status-dot busy" id="status-dot"></span>
        </div>
      </div>
      <div id="image-drafts"></div>
      <div id="input-area">
        <textarea id="input" rows="1" placeholder="${t("向 ZCode 提问，@ 添加上下文，/ 选择能力")}"></textarea>
      </div>
      <div class="composer-toolbar">
        <div class="toolbar-left">
          <button type="button" id="model-chip" class="toolbar-btn" title="${t("切换模型")}" aria-haspopup="menu" aria-expanded="false" aria-controls="popover">model</button>
          <button type="button" id="mode-chip" class="toolbar-btn" title="${t("权限管理")}" aria-haspopup="menu" aria-expanded="false" aria-controls="popover">${t("变更前确认")}</button>
          <button type="button" id="thought-chip" class="toolbar-btn" title="${t("推理强度")}" aria-haspopup="menu" aria-expanded="false" aria-controls="popover">${t("推理强度")}</button>
          <button type="button" id="controls-toggle" class="toolbar-btn" title="${t("展开权限和推理")}" aria-label="${t("展开权限和推理")}" aria-expanded="false"><svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M4.5 2.5 8 6 4.5 9.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <button type="button" id="plan-indicator" class="toolbar-btn" hidden></button>
          <button type="button" id="active-command" class="toolbar-btn active-command" hidden></button>
        </div>
        <button type="button" id="context-meter" class="context-meter" title="${t("上下文窗口")}" aria-label="${t("上下文窗口")}" aria-controls="usage-panel" aria-expanded="false"><span class="usage-ring" id="context-ring-tip"><svg class="context-ring" viewBox="0 0 20 20" aria-hidden="true"><circle class="context-track" cx="10" cy="10" r="7"></circle><circle class="context-value" cx="10" cy="10" r="7"></circle></svg></span><span class="usage-ring" id="five-hour-ring-tip"><svg class="five-hour-ring" viewBox="0 0 20 20" aria-hidden="true"><circle class="context-track" cx="10" cy="10" r="7"></circle><circle class="five-hour-value" cx="10" cy="10" r="7"></circle></svg></span><svg class="usage-chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m2.5 4.5 3.5 3.5 3.5-3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <button type="button" id="insert-now-btn" class="send" title="${t("立即发送（打断当前回复）")}" aria-label="${t("立即发送")}"></button>
        <button type="button" id="send-btn" class="send" title="${t("连接中")}" aria-label="${t("连接中")}" disabled></button>
        <button type="button" id="stop-btn" class="send stop" hidden title="${t("停止")}" aria-label="${t("停止")}"></button>
      </div>
    </div>
    <section id="usage-panel" hidden aria-label="${t("额度与上下文")}">
      <div id="usage-context" class="usage-cell" tabindex="0" role="progressbar" aria-label="${t("上下文窗口")}" aria-valuemin="0" aria-valuemax="100">
        <div class="usage-cell-head"><span id="usage-context-label" class="usage-cell-label">${t("上下文")}</span><span id="usage-context-percent" class="usage-cell-value">—</span><span class="usage-cell-detail"></span></div>
        <div class="usage-track"><div class="usage-fill"></div></div>
      </div>
      <div id="usage-five-hour" class="usage-cell" tabindex="0" role="progressbar" aria-label="${t("5 小时")}" aria-valuemin="0" aria-valuemax="100">
        <div class="usage-cell-head"><span class="usage-cell-label">${t("5时")}</span><span class="usage-cell-value">—</span><span class="usage-cell-detail"></span></div>
        <div class="usage-track"><div class="usage-fill"></div></div>
      </div>
      <div id="usage-weekly" class="usage-cell" tabindex="0" role="progressbar" aria-label="${t("每周")}" aria-valuemin="0" aria-valuemax="100">
        <div class="usage-cell-head"><span class="usage-cell-label">${t("一周")}</span><span class="usage-cell-value">—</span><span class="usage-cell-detail"></span></div>
        <div class="usage-track"><div class="usage-fill"></div></div>
      </div>
    </section>
  </div>

  <div id="overlay">
    <div class="sheet">
      <div class="sheet-head"><span id="overlay-title">${t("Sessions")}</span><button class="icon-btn" id="overlay-close" title="${t("Close")}" aria-label="${t("Close")}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></div>
      <div id="session-tabs" class="session-tabs">
        <button type="button" id="tab-active" class="tab-btn active">${t("Active")}</button>
        <button type="button" id="tab-archived" class="tab-btn">${t("Archived")}</button>
      </div>
      <input id="overlay-search" placeholder="${t("Filter…")}">
      <div id="overlay-list"></div>
    </div>
  </div>

  <div id="setup">
    <div class="sheet">
      <div class="sheet-head"><span id="setup-title">${t("Setup")}</span><button class="icon-btn" id="setup-close" title="${t("Close")}" aria-label="${t("Close")}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></div>
      <div id="setup-hint"></div>
      <div id="setup-recovery"></div>
      <div id="setup-list"></div>
      <div style="padding:8px 10px 12px;display:flex;gap:8px;justify-content:flex-end">
        <button id="btn-retry">${t("Retry desktop login")}</button>
      </div>
    </div>
  </div>

  <div id="toast"></div>
  <div id="tooltip" role="tooltip"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export function getNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
