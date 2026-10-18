import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { changelogIssues } from "./changelogGuard";

const manifest = { version: "1.4.9" };
const notes = (bullet = "- 修复消息显示。", heading = "## 未发布 / Unreleased") =>
  `# 更新日志 / Changelog\n\n${heading}\n\n### 中文\n\n${bullet}\n\n### English\n\n- Fix message rendering.\n`;

const check = (text: string) => changelogIssues(text, manifest);

test("internal release-note entries are rejected with their source line", () => {
  for (const bullet of [
    "- 增加会话切换、语言、存储及浏览器回归检查。",
    "- 为个人、团队套餐及 Start Plan 增加隔离回归用例。",
    "- 补充单元测试。",
    "- 本地测试包版本自动附加北京时间，精确到分钟。",
    "- 已由作者在 Windows 初步实测确认会话可对齐。",
    "- Run live-backend regression checks on the desktop app.",
    "- Extend regression coverage for initial sends.",
    "- Add unit tests for provider switching.",
    "- Initial Windows testing by the author confirms visibility.",
    "- 通过 323 项测试。",
    "- Passed all 323 tests.",
    "- 增加供应商切换的\n  回归测试。",
  ]) {
    const issues = check(notes(bullet));
    assert.equal(issues.length, 1, bullet);
    assert.equal(issues[0].line, 7);
    assert.match(issues[0].reason, /test-coverage|packaging|validation/);
  }
});

test("user-facing test controls and platform guidance are allowed", () => {
  for (const bullet of [
    "- 增加测试连接按钮，帮助检查 API 配置。",
    "- 修复测试连接按钮没有响应的问题。",
    "- Fix the Test Connection button when offline.",
    "- Add a Test Connection button for custom APIs.",
    "- macOS 尚未实测，遇到问题可参考排查说明。",
  ]) assert.deepEqual(check(notes(bullet)), [], bullet);
});

test("only the newest section is checked, including a dated release", () => {
  const old = "\n## 1.4.8 — 2026-10-14\n\n### 中文\n\n- 增加浏览器回归检查。\n";
  assert.deepEqual(check(notes() + old), []);
  assert.deepEqual(changelogIssues(notes(undefined, "## 1.4.9 — 2026-10-17") + old, manifest, { requireRelease: true }), []);
  assert.equal(changelogIssues(notes("- 增加单元测试。", "## 1.4.9 — 2026-10-17"), manifest, { requireRelease: true }).length, 1);
});

test("packaging requires the newest version and a real calendar date", () => {
  assert.deepEqual(changelogIssues(notes(), manifest), [], "development accepts Unreleased without a second extension identity");
  assert.match(changelogIssues(notes(), manifest, { requireRelease: true })[0].reason, /dated release/);
  assert.match(changelogIssues(notes(undefined, "## 1.4.8 — 2026-10-14"), manifest)[0].reason, /match package.json/);
  assert.match(changelogIssues(notes(undefined, "## 1.4.8 — 2026-10-14"), manifest, { requireRelease: true })[0].reason, /match package.json/);
  for (const date of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-00-10"]) {
    assert.match(changelogIssues(notes(undefined, `## 1.4.9 — ${date}`), manifest, { requireRelease: true })[0].reason, /invalid release date/);
  }
  assert.deepEqual(changelogIssues(notes(undefined, "## 1.4.9 — 2024-02-29"), manifest, { requireRelease: true }), []);
  assert.deepEqual(check(notes(undefined, "## 1.4.9 — 2026-10-17")), [], "development also accepts a matching dated release");
});

test("language sections must exist exactly once and contain entries", () => {
  assert.match(check("# Changelog")[0].reason, /missing release section/);
  assert.match(check(notes().replace("## 未发布 / Unreleased", "## Next"))[0].reason, /expected ##/);
  assert.match(check(notes().replace("### English", "### Other"))[0].reason, /expected ###/);
  assert.ok(check(notes().replace("### English\n\n- Fix message rendering.\n", "")).some(issue => /missing English/.test(issue.reason)));
  assert.ok(check(notes().replace("- Fix message rendering.", "")).some(issue => /empty English/.test(issue.reason)));
  assert.ok(check(notes() + "\n### 中文\n\n- 重复。\n").some(issue => /duplicate 中文/.test(issue.reason)));
  assert.ok(check(notes().replace("### 中文", "- 没有语言归属。\n\n### 中文")).some(issue => /belong to a language section/.test(issue.reason)));
});

test("fenced examples do not hide later entries or supply required structure", () => {
  const example = "```md\n## 1.4.9 — 2026-10-17\n### English\n- Add unit tests.\n```\n";
  assert.deepEqual(check(example + notes()), []);
  assert.ok(check(notes().replace("- Fix message rendering.", example)).some(issue => /empty English/.test(issue.reason)));
  assert.ok(check(notes().replace("- Fix message rendering.", example + "- Add unit tests.\n")).some(issue => /test-coverage/.test(issue.reason)));
  assert.deepEqual(check(notes().replaceAll("\n", "\r\n")), []);
});

test("the repository changelog matches its actual build identity", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  assert.deepEqual(changelogIssues(readFileSync("CHANGELOG.md", "utf8"), manifest, { requireRelease: process.env.ZCODE_RELEASE_CHECK === "1" }), [],
    "Fix the newest CHANGELOG section: keep Chinese and English user-facing notes, and date/version the release before packaging.");
});
