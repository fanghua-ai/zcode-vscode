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
