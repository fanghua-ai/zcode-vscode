import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { desktopVersion, issueCategory, redactHome } from "./diagnostics";

test("Diagnostics redact home only at directory boundaries and respect Windows casing", () => {
  assert.equal(redactHome("/home/alice/project", "/home/alice", "linux"), "~/project");
  assert.equal(redactHome("/home/alice2/project", "/home/alice", "linux"), "/home/alice2/project");
  assert.equal(redactHome("c:\\users\\Alice\\项目", "C:\\Users\\alice", "win32"), "~\\项目");
});

test("Recent diagnostic issues contain categories, never error text or secrets", () => {
  assert.equal(issueCategory("sqlite error with api_key=secret"), "storage");
  assert.equal(issueCategory("snapshot failed with private conversation text"), "synchronization");
  assert.equal(issueCategory("credentials invalid token=secret"), "authentication");
  assert.equal(issueCategory("private text only"), "request");
});

test("Desktop version reads packaged ASAR metadata and rejects invalid headers", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-diagnostics-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const binary = path.join(root, "glm", "zcode.cjs");
  const content = Buffer.from(JSON.stringify({version: "3.14.4", token: "DO_NOT_EXPORT"}));
  const index = Buffer.from(JSON.stringify({files: {"package.json": {offset: "0", size: content.length}}}));
  const head = Buffer.alloc(16); head.writeUInt32LE(index.length + 8, 4); head.writeUInt32LE(index.length, 12);
  fs.writeFileSync(path.join(root, "app.asar"), Buffer.concat([head, index, content]));
  assert.equal(desktopVersion(binary), "3.14.4");
  head.writeUInt32LE(0xffffffff, 12);
  fs.writeFileSync(path.join(root, "app.asar"), head);
  assert.equal(desktopVersion(binary), null);
  assert.equal(desktopVersion(""), null);
});
