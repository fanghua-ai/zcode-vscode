export interface FileChange {
  path: string;
  before?: string;
  after?: string;
  added?: number;
  removed?: number;
  kind: "edit" | "write" | "read";
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) return null;
    try {
      const parsed = JSON.parse(t) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function readString(rec: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

function countLines(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  if (text.charCodeAt(text.length - 1) === 10) n--;
  return n;
}

function extractBeforeAfter(raw: unknown): { before: string; after: string } | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const before = readString(rec, ["old_string", "oldString", "oldText", "before"]);
  const after = readString(rec, ["new_string", "newString", "newText", "after", "content"]);
  if (before !== undefined && after !== undefined) return { before, after };
  const meta = asRecord(rec.metadata);
  const filediff = meta ? asRecord(meta.filediff) : null;
  if (filediff) {
    const b = readString(filediff, ["old_string", "oldString", "oldText", "before"]);
    const a = readString(filediff, ["new_string", "newString", "newText", "after", "content"]);
    if (b !== undefined && a !== undefined) return { before: b, after: a };
  }
  return null;
}

export function parseFileChange(
  toolName: string,
  input?: unknown,
  output?: unknown
): FileChange | null {
  const rec = asRecord(input);
  const path = rec
    ? readString(rec, ["path", "file_path", "filePath", "file", "target"])
    : undefined;
  const name = toolName || "";
  const isWrite = /write|create/i.test(name);
  const isEdit = /(edit|patch|replace|applypatch|multi.?edit)/i.test(name);
  const isRead = /^read$/i.test(name) || /readfile/i.test(name);
  if (!path && !isEdit && !isWrite) return null;

  const snippet = extractBeforeAfter(input) ?? extractBeforeAfter(output);
  let before = snippet?.before;
  let after = snippet?.after;
  if (isWrite && rec) {
    after =
      after ??
      readString(rec, ["contents", "content", "text"]);
    if (after !== undefined && before === undefined) before = "";
  }
  if (!path) return null;
  if (!isWrite && !isEdit && !isRead && after === undefined && before === undefined) {
    return null;
  }
  const kind: FileChange["kind"] = isWrite ? "write" : isEdit ? "edit" : "read";
  const added = after !== undefined ? countLines(after) : undefined;
  const removed = before !== undefined ? countLines(before) : undefined;
  return {
    path,
    before,
    after,
    added: isEdit || isWrite ? added : undefined,
    removed: isEdit || isWrite ? removed : undefined,
    kind,
  };
}
