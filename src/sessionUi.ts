import { t } from "./i18n";
import { lucideIcon } from "./lucideIcons";
export type SessionMode = "plan" | "build" | "edit" | "yolo" | "auto";

export interface ModeOption {
  id: SessionMode;
  label: string;
  description: string;
}

export interface ThoughtOption {
  value: string;
  label: string;
  description?: string;
}

export const SESSION_MODES: ModeOption[] = [
  {
    id: "build",
    label: "变更前确认",
    description: "改文件前先问我。",
  },
  {
    id: "edit",
    label: "自动编辑",
    description: "自动编辑文件。",
  },
  {
    id: "plan",
    label: "计划模式",
    description: "编辑前先出计划。",
  },
  {
    id: "yolo",
    label: "完全访问",
    description: "减少确认次数。",
  },
];

const THOUGHT_LABELS: Record<string, string> = {
  off: "关闭",
  none: "关闭",
  noThink: "不思考",
  disabled: "关闭",
  on: "开启",
  enabled: "开启",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  extra_high: "极高",
  max: "最高",
};

export function modeOption(id?: string): ModeOption {
  const mode = SESSION_MODES.find((m) => m.id === id) ?? SESSION_MODES[0];
  return { ...mode, label: t(mode.label), description: t(mode.description) };
}

export function thoughtLabel(value?: string, fallback?: string): string {
  if (!value) return fallback || t("默认");
  return THOUGHT_LABELS[value] ? t(THOUGHT_LABELS[value]) : fallback || value;
}

const THOUGHT_MARKS: Record<string, string> = {
  off: "Off", none: "Off", disabled: "Off", noThink: "Off",
  on: "On", enabled: "On",
  low: "Lo", medium: "Med", high: "Hi",
  xhigh: "XHi", extra_high: "XHi", extraHigh: "XHi", max: "Max",
};

/** Short chip mark. Known levels use a fixed abbreviation; other API values keep a short token. */
export function thoughtMark(value?: string): string {
  if (!value) return "—";
  if (THOUGHT_MARKS[value]) return THOUGHT_MARKS[value];
  const token = value.replace(/[^a-zA-Z0-9]/g, "");
  if (!token) return value.slice(0, 3);
  return token.length <= 4 ? token : token.slice(0, 3);
}

export function modeIcon(id?: string): string {
  const name = id === "edit" ? "shieldCheck"
    : id === "yolo" ? "shieldAlert"
    : id === "plan" ? "clipboardList"
    : "hand";
  return lucideIcon(name, { strokeWidth: 1.6 });
}

export function localizeThoughtLevels(
  levels: ThoughtOption[] | undefined
): ThoughtOption[] {
  return (levels ?? []).map((level) => ({
    ...level,
    label: thoughtLabel(level.value, level.label),
  }));
}

export function permissionOptionLabel(option: {
  optionId?: string;
  kind?: string;
  name?: string;
}): string {
  const key = `${option.optionId ?? ""} ${option.kind ?? ""} ${option.name ?? ""}`.toLowerCase();
  if (/(allow_once|allowonce|allow once)/.test(key)) return t("允许一次");
  if (/(allow_always|allowalways|allow_project|always allow)/.test(key)) {
    return t("始终允许（本项目）");
  }
  if (/(deny|拒绝)/.test(key)) return t("拒绝");
  return option.name || option.optionId || t("选项");
}

export function permissionOptionKind(
  option: { optionId?: string; kind?: string; name?: string }
): "allowOnce" | "allowAlways" | "deny" | "custom" {
  const key = `${option.optionId ?? ""} ${option.kind ?? ""}`.toLowerCase();
  if (/(allow_once|allowonce)/.test(key)) return "allowOnce";
  if (/(allow_always|allowalways|allow_project)/.test(key)) return "allowAlways";
  if (key.includes("deny")) return "deny";
  return "custom";
}
