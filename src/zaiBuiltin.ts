/** GLM / Z.ai server-side tools are streamed as markdown dumps inside assistant text. */

import { formatToolOutput } from "./toolOutput";

export type ZaiSegment =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      toolName: string;
      inputText: string;
      outputText: string;
      status: "running" | "completed";
    };

const HEADER_RE = /\*\*(?:🌐\s*)?Z\.ai\s+(?:Built-in Tool|内置工具)\s*[:：]\s*`?([A-Za-z0-9_.-]+)`?\s*\*\*/g;
const OUTPUT_MARK_RE = /\*\*(?:Output|输出)\s*[:：]\*\*/;
const SUMMARY_MARK_RE = /\*\*`?[A-Za-z0-9_]+_result_summary`?\s*[:：]\*\*/;

function tryParseJson(text: string): unknown | undefined {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function summarizeValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") {
    return v.trim();
  }
  if (Array.isArray(v)) {
    return v.map(summarizeValue).filter(Boolean).join("\n\n");
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("text" in o) return summarizeValue(o.text);
    const lines: string[] = [];
    if (typeof o.title === "string") lines.push(o.title);
    const href = typeof o.url === "string" ? o.url : typeof o.link === "string" ? o.link : "";
    if (href) lines.push(href);
    if (typeof o.description === "string") lines.push(o.description);
    if (typeof o.content === "string") {
      lines.push(o.content.trim());
    }
    if (lines.length) return lines.join("\n");
  }
  try {
    const s = JSON.stringify(v, null, 2);
    return s;
  } catch {
    return String(v);
  }
}

export function formatZaiToolOutput(raw: string): string {
  const stripped = raw
    .replace(/^\s*\*Executing on server\.\.\.\*\s*/i, "")
    .replace(/^\s*\*\*(?:Output|输出)\s*[:：]\*\*\s*/i, "")
    .replace(new RegExp(`^\\s*${SUMMARY_MARK_RE.source}\\s*`, "i"), "")
    .trim();
  if (!stripped) return "";
  return formatToolOutput(stripped);
}

/** Find the end of a complete JSON output, leaving subsequent assistant prose intact. */
function splitOutputProse(raw: string): {output:string;rest:string} {
  const prefix=new RegExp(`^\\s*(?:${SUMMARY_MARK_RE.source}\\s*)?`).exec(raw)![0];
  const start=prefix.length;
  if (!/[\[{]/.test(raw[start] || "")) return {output:raw,rest:""};
  let depth=0, quoted=false, escaped=false;
  for (let i=start;i<raw.length;i++) {
    const c=raw[i];
    if (quoted) { if (escaped) escaped=false; else if (c==="\\") escaped=true; else if (c==='"') quoted=false; continue; }
    if (c==='"') quoted=true;
    else if (c==="[" || c==="{") depth++;
    else if (c==="]" || c==="}") {
      if (--depth===0) {
        try { JSON.parse(raw.slice(start,i+1)); } catch { return {output:raw,rest:""}; }
        return {output:raw.slice(0,i+1),rest:raw.slice(i+1).trim()};
      }
    }
  }
  return {output:raw,rest:""};
}

function parseBuiltinBody(body: string, toolName: string): {
  input: string;
  output: string;
  rest: string;
  complete: boolean;
} {
  let rest = "";
  let work = body;
  const pad = work.match(/\n[ \t]{8,}(?=\S)/);
  if (pad?.index != null) {
    const after = work.slice(pad.index).trimStart();
    if (after && !/^[\s\[\{\]\}",]/.test(after) && !after.startsWith("```")) {
      rest = after;
      work = work.slice(0, pad.index);
    }
  }

  const fence = /```json\s*([\s\S]*?)(?:```|$)/.exec(work);
  const input = fence ? fence[1].trim() : "";
  const outMark = OUTPUT_MARK_RE.exec(work);
  const executing = /\*Executing on server/i.test(work);
  let outputRaw = "";
  let complete = false;
  if (outMark) {
    const output = splitOutputProse(work.slice(outMark.index + outMark[0].length));
    outputRaw = output.output;
    rest = [output.rest, rest].filter(Boolean).join("\n\n");
    complete = true;
  } else if (executing || input) {
    complete = false;
  }
  return {
    input,
    output: toolName === "analyze_image"
      ? formatImageAnalysisOutput(outputRaw)
      : formatZaiToolOutput(outputRaw),
    rest,
    complete,
  };
}

export function splitZaiBuiltin(text: string): ZaiSegment[] {
  if (!text) return [];
  HEADER_RE.lastIndex = 0;
  const matches = [...text.matchAll(HEADER_RE)];
  if (matches.length === 0) return [{ kind: "text", text }];

  const parts: ZaiSegment[] = [];
  let last = 0;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index ?? 0;
    if (start > last) {
      const prose = text.slice(last, start);
      if (prose.trim()) parts.push({ kind: "text", text: prose });
    }
    const name = m[1].trim();
    const bodyStart = start + m[0].length;
    const nextStart = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    const parsed = parseBuiltinBody(text.slice(bodyStart, nextStart), name);
    parts.push({
      kind: "tool",
      toolName: name,
      inputText: parsed.input,
      outputText: parsed.output,
      status: parsed.complete ? "completed" : "running",
    });
    if (parsed.rest.trim()) parts.push({ kind: "text", text: parsed.rest });
    last = nextStart;
  }
  if (last < text.length) {
    const prose = text.slice(last);
    if (prose.trim()) parts.push({ kind: "text", text: prose });
  }
  return parts;
}

export function prettifyToolIo(text: string): string {
  if (!text) return "";
  if (!/Z\.ai\s+(?:Built-in Tool|内置工具)/.test(text)) return formatToolOutput(text);
  const parts = splitZaiBuiltin(text);
  if (parts.length === 1 && parts[0].kind === "text") {
    return formatZaiToolOutput(text);
  }
  const out: string[] = [];
  for (const part of parts) {
    if (part.kind === "text") {
      const t = part.text
        .replace(/^Web search results for query:.*$/m, "")
        .replace(/^Summary:\s*$/m, "")
        .trim();
      if (t) out.push(t);
    } else {
      const bits = [part.outputText || part.inputText].filter(Boolean);
      if (bits.length) out.push(bits.join("\n"));
    }
  }
  return out.join("\n\n").trim();
}

/** The image service can wrap its textual result in a JSON text-content array,
 * then encode the text itself as another JSON string. Decode only valid layers. */
export function formatImageAnalysisOutput(raw: string): string {
  let value: unknown = raw.replace(
    new RegExp(`^\\s*${SUMMARY_MARK_RE.source}\\s*`, "i"),
    ""
  ).trim();
  for (let depth = 0; depth < 4; depth++) {
    if (typeof value === "string") {
      const text = value;
      try { value = JSON.parse(text); continue; } catch { return prettifyToolIo(text); }
    }
    if (Array.isArray(value)) return value.map(item => {
      if (item && typeof item === "object" && typeof item.text === "string") return formatImageAnalysisOutput(item.text);
      return summarizeValue(item);
    }).filter(Boolean).join("\n\n");
    if (value && typeof value === "object") {
      const object = value as Record<string,unknown>;
      if (typeof object.text === "string") { value=object.text; continue; }
      if (Array.isArray(object.content)) { value=object.content; continue; }
    }
    return summarizeValue(value);
  }
  return typeof value === "string" ? value : summarizeValue(value);
}
