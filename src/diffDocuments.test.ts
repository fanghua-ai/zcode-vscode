import assert from "node:assert/strict";
import test from "node:test";
import { DiffDocuments } from "./diffDocuments";

test("diff URIs stay on the virtual scheme and retain the original basename", () => {
  const docs = new DiffDocuments();
  try {
    const before = docs.uri("before", "src\\app.ts", "old");
    const after = docs.uri("after", "/home/me/src/app.ts", "new");
    assert.equal(before.scheme, DiffDocuments.scheme);
    assert.equal(after.scheme, DiffDocuments.scheme);
    assert.match(before.path, /\/before\/.*app\.ts$/);
    assert.match(after.path, /\/after\/.*app\.ts$/);
    assert.notEqual(before.query, after.query);
    assert.equal(docs.provideTextDocumentContent(before), "old");
    assert.equal(docs.provideTextDocumentContent(after), "new");
  } finally {
    docs.dispose();
  }
});


test("closing a virtual document releases only its own content", async () => {
  const { closeTestDocument } = await import("./testSupport/vscode");
  const docs = new DiffDocuments();
  const before = docs.uri("before", "file.ts", "old");
  const after = docs.uri("after", "file.ts", "new");
  closeTestDocument(before);
  assert.equal(docs.provideTextDocumentContent(before), "");
  assert.equal(docs.provideTextDocumentContent(after), "new");
  docs.dispose();
  assert.equal(docs.provideTextDocumentContent(after), "");
});

test("release removes one virtual document without affecting its pair", () => {
  const docs = new DiffDocuments();
  const before = docs.uri("before", "file.ts", "old");
  const after = docs.uri("after", "file.ts", "new");
  docs.release(before);
  assert.equal(docs.provideTextDocumentContent(before), "");
  assert.equal(docs.provideTextDocumentContent(after), "new");
  docs.dispose();
});
