import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { existingWorkspaceFile, previewFilesForReply } from "./filePreview";

test("generated Markdown gets a card only when this turn changed the existing workspace file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-preview-"));
  try {
    const root = path.join(dir, "workspace");
    fs.mkdirSync(root);
    const generated = path.join(root, "test-hello.md");
    const older = path.join(root, "older.md");
    const outside = path.join(dir, "outside.md");
    for (const file of [generated, older, outside]) fs.writeFileSync(file, "test");
    const candidates = [older, generated, generated, outside];
    assert.deepEqual(previewFilesForReply(root, candidates, ["test-hello.md"], "active"), [
      { path: "test-hello.md", name: "test-hello.md", kind: "markdown", extension: "MD" },
    ]);
    assert.deepEqual(previewFilesForReply(root, candidates, ["test-hello.md"], "reverted"), []);
    assert.deepEqual(previewFilesForReply(root, candidates, [], "active"), []);
    assert.equal(existingWorkspaceFile(root, "../outside.md"), null);
    let linked = false;
    try { fs.symlinkSync(outside, path.join(root, "linked.md")); linked = true; }
    catch (e) { if (process.platform !== "win32") throw e; }
    if (linked) assert.equal(existingWorkspaceFile(root, "linked.md"), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("PDF and Office files can be previewed without a file-change summary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-preview-docs-"));
  try {
    fs.writeFileSync(path.join(root, "report.pdf"), "pdf");
    fs.writeFileSync(path.join(root, "sheet.xlsx"), "xlsx");
    assert.deepEqual(previewFilesForReply(root, ["report.pdf", "sheet.xlsx", "missing.docx"], [], undefined)
      .map(card => [card.name, card.kind]), [["sheet.xlsx", "spreadsheet"], ["report.pdf", "pdf"]]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
