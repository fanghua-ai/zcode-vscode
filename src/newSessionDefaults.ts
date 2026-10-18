export interface SessionModelChoice {
  providerId: string;
  modelId: string;
}

export interface NewSessionDefaults {
  model?: SessionModelChoice;
  mode?: "build" | "edit" | "plan" | "yolo";
  thoughtLevel?: string;
}

const SESSION_DEFAULT_MODES = new Set(["build", "edit", "plan", "yolo"]);

export function normalizeNewSessionDefaults(value: unknown): NewSessionDefaults {
  if (!value || typeof value !== "object") return {};
  const row = value as Record<string, unknown>;
  const modelRow = row.model && typeof row.model === "object"
    ? row.model as Record<string, unknown>
    : undefined;
  const providerId = typeof modelRow?.providerId === "string" ? modelRow.providerId.trim() : "";
  const modelId = typeof modelRow?.modelId === "string" ? modelRow.modelId.trim() : "";
  const mode = typeof row.mode === "string" && SESSION_DEFAULT_MODES.has(row.mode)
    ? row.mode as NewSessionDefaults["mode"]
    : undefined;
  const thoughtLevel = typeof row.thoughtLevel === "string" && row.thoughtLevel.length <= 80
    ? row.thoughtLevel.trim() || undefined
    : undefined;
  return {
    ...(providerId && modelId ? { model: { providerId, modelId } } : {}),
    ...(mode ? { mode } : {}),
    ...(thoughtLevel ? { thoughtLevel } : {}),
  };
}

export function sameSessionModel(
  left: SessionModelChoice | undefined | null,
  right: SessionModelChoice | undefined | null
): boolean {
  return !!left && !!right && left.providerId === right.providerId && left.modelId === right.modelId;
}
