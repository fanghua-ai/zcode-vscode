import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_PLUGIN_SKILL_PROMPTS,
  desktopPluginForSkill,
  withDesktopPluginSkillPrompts,
} from "./desktopPluginSkillPrompts";

test("suppressed desktop plugin skills are listed until the real catalog has them", () => {

  const listed = withDesktopPluginSkillPrompts(
    [{ name: "fitools", description: "local", path: "/skills/fitools" }],
    [],
  );
  assert.equal(listed[0].name, "fitools");
  assert.equal("gated" in listed[0], false);
  const docx = listed.find(skill => skill.name === "docx");
  assert.deepEqual(docx, {
    name: "docx",
    description: "创建和编辑 Word 文档",
    path: "zcode-desktop-plugin-skill:docx",
    gated: true,
  });
  assert.equal(listed.filter(skill => skill.name === "computer-use").length, 0);
  assert.equal(listed.length, 1 + DESKTOP_PLUGIN_SKILL_PROMPTS.length);
});

test("a real skill of the same name is not replaced by the setting prompt", () => {
  const listed = withDesktopPluginSkillPrompts(
    [{ name: "DOCX", description: "from the server", path: "/plugins/docx/SKILL.md" }],
    [],
  );
  assert.deepEqual(listed.filter(skill => skill.name.toLowerCase() === "docx"), [
    { name: "DOCX", description: "from the server", path: "/plugins/docx/SKILL.md" },
  ]);
  assert.equal(withDesktopPluginSkillPrompts([{ name: "docx", description: "", path: "/x" }], [], false).length, 1);
});

test("allowing Word does not allow PDF or browser skills", () => {
  const listed = withDesktopPluginSkillPrompts([], ["documents"]);
  assert.equal(listed.some(skill => skill.name === "docx"), false);
  assert.equal(listed.some(skill => skill.name === "pdf"), true);
  assert.equal(desktopPluginForSkill("docx"), "documents");
  assert.equal(desktopPluginForSkill("unknown"), undefined);
});
