import assert from "node:assert/strict";
import test from "node:test";
import { sameWorkspacePath, preferredWorkspacePath } from "./workspacePath";

test("Windows workspace comparison accepts drive, directory case, separators and trailing slash", () => {
  assert.ok(sameWorkspacePath("e:\\Projects\\项目", "E:/projects/项目/", "win32"));
  assert.ok(sameWorkspacePath("\\\\SERVER\\Share\\Folder", "\\\\server\\share\\folder\\", "win32"));
  assert.ok(sameWorkspacePath("e:\\", "E:/", "win32"));
  assert.ok(!sameWorkspacePath("E:\\Projects\\项目", "E:\\Projects\\项目2", "win32"));
});

test("New Windows sessions use desktop spelling, or uppercase drive when not registered", () => {
  assert.equal(preferredWorkspacePath("e:\\Projects\\项目", ["E:\\Projects\\项目"], "win32"), "E:\\Projects\\项目");
  assert.equal(preferredWorkspacePath("e:/Projects/项目", [], "win32"), "E:\\Projects\\项目");
});

test("Linux retains exact workspace identity and request path", () => {
  assert.ok(!sameWorkspacePath("/project/A", "/project/a", "linux"));
  assert.ok(!sameWorkspacePath("/project", "/project/", "linux"));
  assert.equal(preferredWorkspacePath("/project/a", ["/project/A"], "linux"), "/project/a");
});

test("macOS preserves case distinctions and Chinese directories with spaces", () => {
  const folder = "/Users/person/项目 空格";
  assert.equal(preferredWorkspacePath(folder, [folder], "darwin"), folder);
  assert.ok(sameWorkspacePath(folder, folder, "darwin"));
  assert.ok(!sameWorkspacePath("/Volumes/Work/Project", "/Volumes/Work/project", "darwin"));
});
