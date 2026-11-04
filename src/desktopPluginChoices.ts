/** Plugins that the extension may suppress without changing desktop preferences. */
export const DESKTOP_PLUGIN_CHOICES = [
  { id: "documents", label: "Word" },
  { id: "pdf", label: "PDF" },
  { id: "presentations", label: "演示文稿" },
  { id: "spreadsheets", label: "表格" },
  { id: "browser-use", label: "浏览器" },
  { id: "computer-use", label: "电脑控制" },
  { id: "zcode-site", label: "Sites" },
] as const;

export function allowedDesktopPlugins(value: unknown): string[] {
  return DESKTOP_PLUGIN_CHOICES.filter(choice => Array.isArray(value) && value.includes(choice.id)).map(choice => choice.id);
}

export function suppressedDesktopPluginIds(allowed: readonly string[]): string[] {
  const ids = DESKTOP_PLUGIN_CHOICES.filter(choice => !allowed.includes(choice.id)).map(choice => `${choice.id}@zcode-plugins-official`);
  if (!allowed.includes("computer-use")) ids.push("zcode-cua@zcode-plugins-official");
  return ids;
}
