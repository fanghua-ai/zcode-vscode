export const CONTEXT_TAG_OPEN =
  '<vscode-context note="added by the editor, not typed by the user">';
export const CONTEXT_TAG_CLOSE = "</vscode-context>";

export interface ContextChip {
  path: string;
  relPath: string;
  languageId?: string;
  selectionStart?: number;
  selectionEnd?: number;
  selectedText?: string;
  implicit?: boolean;
  hidden?: boolean;
  snapshot?: string;
  sourceDirty?: boolean;
}

/** A reference to a conversation in the current workspace. Kept distinct from file chips. */
export interface SessionReference {
  sessionId: string;
  title: string;
}

function normalizeSessionTitle(title: string): string {
  return title.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function validSessionReference(reference: SessionReference): boolean {
  return /^sess_[A-Za-z0-9_-]+$/.test(reference.sessionId) && !!normalizeSessionTitle(reference.title);
}

function sessionMarkdownRef(reference: SessionReference): string {
  return `[#${escapeMdLabel(normalizeSessionTitle(reference.title))}](#${reference.sessionId})`;
}

export function fileBaseName(relPath: string): string {
  return relPath.split(/[\\/]/).pop() || relPath;
}

export function chipLabel(chip: ContextChip): string {
  const name = fileBaseName(chip.relPath);
  if (chip.selectionStart && chip.selectionEnd) {
    return chip.selectionStart === chip.selectionEnd
      ? `${name} L${chip.selectionStart}`
      : `${name} L${chip.selectionStart}-L${chip.selectionEnd}`;
  }
  return name;
}

export function chipTitle(chip: ContextChip): string {
  if (chip.selectionStart && chip.selectionEnd) {
    const range =
      chip.selectionStart === chip.selectionEnd
        ? `L${chip.selectionStart}`
        : `L${chip.selectionStart}-L${chip.selectionEnd}`;
    return `${chip.relPath} (${range})`;
  }
  if (chip.hidden) return `已对模型隐藏 · 点击重新附带：${chip.relPath}`;
  return chip.implicit
    ? `当前打开的文件（点击可对模型隐藏）：${chip.relPath}`
    : chip.relPath;
}

function markdownPath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("./") ||
    normalized.startsWith("../") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(normalized)
  ) {
    return normalized;
  }
  return `./${normalized}`;
}

function escapeMdLabel(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/]/g, "\\]");
}

function escapeMdUrl(text: string): string {
  return text.replace(/%/g,"%25").replace(/#/g,"%23").replace(/</g,"%3C").replace(/>/g,"%3E").replace(/\r/g,"%0D").replace(/\n/g,"%0A");
}

/** Desktop-style file mention: `[desktop.ts](./src/desktop.ts)` or `#L10-L20`. */
export function fileMarkdownRef(chip: ContextChip): string {
  const name = fileBaseName(chip.relPath);
  let href = escapeMdUrl(markdownPath(chip.relPath));
  if (chip.selectionStart && chip.selectionEnd) {
    href +=
      chip.selectionStart === chip.selectionEnd
        ? `#L${chip.selectionStart}`
        : `#L${chip.selectionStart}-L${chip.selectionEnd}`;
  }
  return `[${escapeMdLabel(name)}](${/[\s()]/.test(href) ? `<${href}>` : href})`;
}

function fenceLang(languageId?: string): string {
  if (!languageId) return "";
  const map: Record<string, string> = {
    typescript: "ts",
    typescriptreact: "tsx",
    javascript: "js",
    javascriptreact: "jsx",
    markdown: "md",
    shellscript: "bash",
  };
  return map[languageId] || languageId;
}

export function buildPrompt(text: string, chips: ContextChip[], sessionRefs: SessionReference[] = []): string {
  const parts: string[] = [];
  const seen = new Set<string>();

  for (const reference of sessionRefs) {
    if (!validSessionReference(reference) || seen.has(reference.sessionId)) continue;
    seen.add(reference.sessionId);
    parts.push(sessionMarkdownRef(reference));
  }

  for (const chip of chips) {
    if (chip.hidden) continue;
    const windows = /^(?:[a-z]:[\\/]|\\\\)/i.test(chip.path);
    const identity = windows ? chip.path.replace(/\\/g,"/").toLowerCase() : chip.path;
    const key = `${identity}:${chip.selectionStart ?? 0}-${chip.selectionEnd ?? 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const link = fileMarkdownRef(chip);
    const snapshot = chip.snapshot ?? (chip.selectionStart && chip.selectionEnd ? chip.selectedText : undefined);
    if (snapshot !== undefined) {
      const lang = fenceLang(chip.languageId).replace(/[^a-zA-Z0-9_+-]/g, "");
      let ticks = 3;
      for (const match of snapshot.matchAll(/`+/g)) ticks = Math.max(ticks, match[0].length + 1);
      const fence = "`".repeat(ticks);
      parts.push(`${link}\n${fence}${lang}\n${snapshot}\n${fence}`);
    } else parts.push(link);
  }

  return [...parts, text].filter(Boolean).join("\n\n");
}

function unescapeMdLabel(text: string): string {
  return text.replace(/\\([\\[\]])/g, "$1");
}

function parseLeadingSessionLink(text: string): { reference: SessionReference; rest: string } | null {
  const match = text.match(/^\[#((?:\\.|[^\\\]])*)\]\(#(sess_[A-Za-z0-9_-]+)\)/);
  if (!match) return null;
  return {
    reference: { sessionId: match[2], title: unescapeMdLabel(match[1]) },
    rest: text.slice(match[0].length).replace(/^[ \t]*(?:\n+|[ \t]+)/, ""),
  };
}

/** Remove serialized leading conversation references while preserving file refs and user text. */
export function stripSessionReferences(text: string): string {
  let rest = text;
  for (;;) {
    const link = parseLeadingSessionLink(rest);
    if (!link) return rest;
    rest = link.rest;
  }
}

function parseLeadingFileLink(text: string): {
  label: string;
  title: string;
  hasRange: boolean;
  rest: string;
} | null {
  const m = text.match(
    /^\[((?:\\.|[^\\\]])*)\]\((?:<((?:\\.|[^>])*?)>|((?:\\.|[^)\s])*))\)/
  );
  if (!m || m.index !== 0) return null;
  const href = (m[2] || m[3] || "").trim();
  if (/^https?:/i.test(href) || href.startsWith("plugin://") || href.startsWith("#")) {
    return null;
  }
  const name = unescapeMdLabel(m[1]);
  const hash = href.match(/#L(\d+)(?:-L(\d+))?$/);
  let path = href.replace(/#L\d+(?:-L\d+)?$/, "");
  try { path = decodeURIComponent(path); } catch { /* Legacy unescaped path. */ }
  const label = hash
    ? hash[2]
      ? `${name} L${hash[1]}-L${hash[2]}`
      : `${name} L${hash[1]}`
    : name;
  const title = hash
    ? hash[2]
      ? `${path} (L${hash[1]}-L${hash[2]})`
      : `${path} (L${hash[1]})`
    : path;
  return {
    label,
    title,
    hasRange: !!hash,
    rest: text.slice(m[0].length).replace(/^\n+/, ""),
  };
}

export function parsePromptDisplay(text: string): {
  body: string;
  chips: Array<{ label: string; title: string }>;
  sessionRefs: SessionReference[];
} {
  if (!text) return { body: "", chips: [], sessionRefs: [] };
  const chips: Array<{ label: string; title: string }> = [];
  const sessionRefs: SessionReference[] = [];
  let rest = text;
  const ctx = rest.match(
    /<vscode-context[^>]*>\n?([\s\S]*?)\n?<\/vscode-context>\s*/
  );
  if (ctx) {
    for (const raw of ctx[1].split("\n")) {
      const line = raw.trim();
      const attached = line.match(/^Attached file: (.+)$/);
      const open = line.match(/^Currently open in the editor \(for context\): (.+)$/);
      const bullet = line.match(/^- (.+)$/);
      const path = attached?.[1] || open?.[1] || bullet?.[1];
      if (path) {
        chips.push({ label: fileBaseName(path), title: path });
      }
    }
    rest = (rest.slice(0, ctx.index) + rest.slice(ctx.index! + ctx[0].length)).trim();
  }
  const OLD_HEADER =
    /^`([^`\n]+)` \(lines ([1-9]\d*)-([1-9]\d*)\):\n```[^\n]*\n[\s\S]*?(?:^|\n)```[ \t]*(?:\n|$)/;
  for (;;) {
    const m = rest.match(OLD_HEADER);
    if (!m || m.index !== 0) break;
    const name = fileBaseName(m[1]);
    chips.push({
      label: `${name} L${m[2]}-L${m[3]}`,
      title: `${m[1]} (L${m[2]}-L${m[3]})`,
    });
    rest = rest.slice(m[0].length).replace(/^\n+/, "");
  }
  for (;;) {
    const sessionLink = parseLeadingSessionLink(rest);
    if (!sessionLink) break;
    if (!sessionRefs.some(reference => reference.sessionId === sessionLink.reference.sessionId)) sessionRefs.push(sessionLink.reference);
    rest = sessionLink.rest;
  }
  for (;;) {
    const link = parseLeadingFileLink(rest);
    if (!link) break;
    chips.push({ label: link.label, title: link.title });
    rest = link.rest;
    {
      const fence = rest.match(/^(`{3,})[^\n]*\n[\s\S]*?(?:^|\n)\1[ \t]*(?:\n|$)/);
      if (fence && fence.index === 0) {
        rest = rest.slice(fence[0].length).replace(/^\n+/, "");
      }
    }
  }
  return { body: rest.trim(), chips, sessionRefs };
}
