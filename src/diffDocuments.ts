import { randomUUID } from "crypto";
import * as vscode from "vscode";

/** Read-only virtual docs for vscode.diff — avoids untitled tabs and save prompts. */
export class DiffDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly scheme = "zcode-diff";

  private readonly contents = new Map<string, string>();

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  /** Build a unique URI whose path ends with the real filename for language mode. */
  uri(side: "before" | "after", filePath: string, content: string): vscode.Uri {
    const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
    const uri = vscode.Uri.from({
      scheme: DiffDocuments.scheme,
      path: `/${side}/${normalized || "file"}`,
      query: randomUUID(),
    });
    this.contents.set(uri.toString(), content);
    return uri;
  }

  dispose(): void {
    this.contents.clear();
  }
}
