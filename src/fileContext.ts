import * as path from "path";
import { LocalizedError } from "./i18n";
import type { ContextChip } from "./promptContext";
import { sameWorkspacePath } from "./workspacePath";

export interface EditorDocument {
  uri: { fsPath: string };
  isDirty: boolean;
  languageId: string;
  getText(): string;
}

/** File mentions follow the latest editor buffer; pinned selections keep their snapshot. */
export function prepareFileContext(
  chips: ContextChip[], workspaceRoot: string, documents: readonly EditorDocument[],
): ContextChip[] {
  return chips.map(chip => {
    const prepared = { ...chip, ...(workspaceRoot ? {relPath:path.relative(workspaceRoot, chip.path)} : {}) };
    if (chip.hidden || (chip.selectionStart && chip.selectionEnd)) return prepared;
    const document = documents.find(document => sameWorkspacePath(document.uri.fsPath, chip.path));
    if (!document) return prepared;
    delete prepared.snapshot;
    if (document.isDirty) {
      const snapshot = document.getText();
      if (snapshot.length > 1024 * 1024) throw new LocalizedError("未保存的文件过大，请选中需要引用的内容。");
      prepared.snapshot = snapshot;
      prepared.languageId = document.languageId;
    }
    return prepared;
  });
}
