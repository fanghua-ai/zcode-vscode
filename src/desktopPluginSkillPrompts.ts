/** Suppressed skills remain discoverable as prompts that allow only their owning plugin. */
export const DESKTOP_PLUGIN_SKILL_PROMPTS = [
  { name: "docx", description: "创建和编辑 Word 文档" },
  { name: "docx-viewer", description: "在侧栏查看 Word 文档" },
  { name: "pdf", description: "创建、转换和处理 PDF" },
  { name: "pdf-viewer", description: "在侧栏查看 PDF" },
  { name: "pptx", description: "创建和编辑演示文稿" },
  { name: "pptx-viewer", description: "在侧栏查看演示文稿" },
  { name: "xlsx", description: "创建和编辑表格" },
  { name: "xlsx-viewer", description: "在侧栏查看表格" },
  { name: "control-browser", description: "操作内置浏览器" },
  { name: "web-gui-tester", description: "用浏览器测试网页界面" },
] as const;

export type DesktopPluginSkillPrompt = {
  name: string;
  description: string;
  path: string;
  gated: true;
};

export function desktopPluginForSkill(name: string): string | undefined {
  if (name === "docx" || name === "docx-viewer") return "documents";
  if (name === "pdf" || name === "pdf-viewer") return "pdf";
  if (name === "pptx" || name === "pptx-viewer") return "presentations";
  if (name === "xlsx" || name === "xlsx-viewer") return "spreadsheets";
  if (name === "control-browser" || name === "web-gui-tester") return "browser-use";
  return undefined;
}

export function withDesktopPluginSkillPrompts<T extends { name: string }>(
  skills: readonly T[],
  allowed: readonly string[],
  show = true,
): Array<T | DesktopPluginSkillPrompt> {
  if (!show) return [...skills];
  const present = new Set(skills.map(skill => skill.name.toLowerCase()));
  const prompts: DesktopPluginSkillPrompt[] = [];
  for (const skill of DESKTOP_PLUGIN_SKILL_PROMPTS) {
    if (present.has(skill.name.toLowerCase()) || allowed.includes(desktopPluginForSkill(skill.name) || "")) continue;
    prompts.push({
      name: skill.name,
      description: skill.description,
      path: `zcode-desktop-plugin-skill:${skill.name}`,
      gated: true,
    });
  }
  return [...skills, ...prompts];
}
