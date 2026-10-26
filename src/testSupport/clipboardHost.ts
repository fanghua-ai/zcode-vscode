import * as fs from "node:fs";
import * as vscode from "vscode";
import { getWebviewHtml } from "../webviewHtml";

/** Real Electron webview fixture; no desktop backend or user data. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const report = process.env.ZCODE_CLIPBOARD_EVENTS!;
  const saved = await vscode.env.clipboard.readText();
  const root = vscode.Uri.file(process.env.ZCODE_CLIPBOARD_REPO!);
  const panel = vscode.window.createWebviewPanel("zcode.clipboard.test", "Clipboard regression", vscode.ViewColumn.One, {
    enableScripts: true, localResourceRoots: [root],
  });
  context.subscriptions.push(panel);
  const reply = (value: unknown) => fs.appendFileSync(report, JSON.stringify(value) + "\n");
  panel.webview.onDidReceiveMessage(async (message: { type: string; id?: number; expected?: string }) => {
    try {
      if (message.type === "ready") {
        for (const data of [
          { type: "view_reset", clear: true, viewGen: 1 },
          { type: "session_ready", sessionId: "clipboard-test", viewGen: 1 },
          { type: "history", sessionId: "clipboard-test", viewGen: 1, items: [
            { id: "question", role: "user", text: "Clipboard fixture" },
            { id: "answer", role: "assistant", text: "FIRST_COPY_SENTINEL\n\nSECOND_COPY_SENTINEL" },
          ] },
          { type: "stream_release" },
        ]) await panel.webview.postMessage(data);
      } else if (message.type === "clipboard_test_seed") {
        await vscode.env.clipboard.writeText("BEFORE_COPY_SENTINEL");
        reply({ id: message.id });
      } else if (message.type === "clipboard_test_read") {
        const value = await vscode.env.clipboard.readText();
        const normalize = (text: string) => text.replace(/\r\n/g, "\n");
        reply({ id: message.id, matches: normalize(value) === normalize(message.expected ?? ""),
          unchanged: value === "BEFORE_COPY_SENTINEL", length: value.length });
      } else if (message.type === "clipboard_test_restore") {
        await vscode.env.clipboard.writeText(saved);
        reply({ id: message.id });
      }
    } catch (error) {
      reply({ id: message.id, error: String(error) });
    }
  });
  // Keep the real VS Code bridge; expose it only to this isolated test driver.
  const html = getWebviewHtml(panel.webview, root, "clipboard-test");
  panel.webview.html = html.replace('<script nonce=',
    '<script nonce="clipboard-test">window.clipboardTestApi=acquireVsCodeApi();window.acquireVsCodeApi=()=>window.clipboardTestApi;</script><script nonce=');
  reply({ type: "host", vscode: vscode.version, platform: process.platform, arch: process.arch });
}
