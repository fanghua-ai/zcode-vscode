/** GLM / Z.ai server-side tools are streamed as markdown dumps inside assistant text. */

import { formatToolOutput, parsePartialJsonContainer } from "./toolOutput";
import { t } from "./i18n";

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

function splitIndentedProse(text: string): { body: string; rest: string } {
  const pad = /\n[ \t]{8,}(?=\S)/.exec(text);
  if (pad?.index != null) {
    const after = text.slice(pad.index).trimStart();
    if (after && !/^[\s\[\{\]\}",]/.test(after) && !after.startsWith("```")) {
      return { body: text.slice(0, pad.index), rest: after };
    }
  }
  return { body: text, rest: "" };
}

function fenceBounds(text: string, open: RegExpMatchArray): { bodyStart: number; bodyEnd: number; end: number } {
  const bodyStart = open.index! + open[0].length;
  const closing = new RegExp(`^ {0,3}${open[1][0]}{${open[1].length},}[ \\t]*(?:\\r?\\n|$)`, "gm");
  closing.lastIndex = bodyStart;
  const close = closing.exec(text);
  return { bodyStart, bodyEnd: close?.index ?? text.length, end: close ? close.index + close[0].length : text.length };
}

function inlineCodeEnd(text: string, start: number, ticks: string): number | undefined {
  let escapes = 0;
  for (let at = start - 1; at >= 0 && text[at] === "\\"; at--) escapes++;
  if (escapes % 2) return;
  const rest = text.slice(start + ticks.length);
  // A blank line ends the Markdown paragraph; it cannot close this code span.
  const paragraphEnd = /\r?\n[ \t]*\r?\n/.exec(rest)?.index ?? rest.length;
  for (const close of rest.matchAll(/`+/g)) {
    if (close.index! >= paragraphEnd) break;
    if (close[0].length === ticks.length) return start + ticks.length + close.index! + close[0].length;
  }
}

/** Labels inside JSON parameters or results are data, not tool boundaries. */
function builtinMarkers(text: string, pattern: RegExp): RegExpMatchArray[] {
  const ranges: Array<{ start: number; end: number }> = [];
  const markers = new RegExp("^ {0,3}(`{3,}|~{3,})([^\\r\\n]*)(?:\\r?\\n|$)|" + OUTPUT_MARK_RE.source + "|(`+)", "gm");
  let protectedUntil = 0;
  for (const marker of text.matchAll(markers)) {
    const start = marker.index!;
    if (start < protectedUntil) continue;
    const bodyStart = start + marker[0].length;
    let protectedStart = start;
    if (marker[1]) {
      // A fence starts a line; backticks within JSON strings or code are data.
      if (marker[1][0] === "`" && marker[2].includes("`")) continue;
      protectedUntil = fenceBounds(text, marker).end;
    } else if (marker[3]) {
      const end = inlineCodeEnd(text, start, marker[3]);
      if (end === undefined) continue;
      protectedUntil = end;
    } else {
      const { body } = splitIndentedProse(text.slice(bodyStart));
      const prefix = new RegExp(`^\\s*(?:${SUMMARY_MARK_RE.source}\\s*)?`).exec(body)![0];
      if (!/^[\[{]/.test(body.slice(prefix.length))) continue;
      // Keep the real Output label visible while protecting its JSON value.
      protectedStart = bodyStart;
      protectedUntil = bodyStart + splitOutputProse(body).output.length;
    }
    ranges.push({ start: protectedStart, end: protectedUntil });
  }
  let range = 0;
  return [...text.matchAll(new RegExp(pattern.source, "g"))].filter(match => {
    while (range < ranges.length && ranges[range].end <= match.index!) range++;
    return range >= ranges.length || match.index! < ranges[range].start;
  });
}

function parseBuiltinBody(body: string, toolName: string): {
  input: string;
  output: string;
  rest: string;
  complete: boolean;
} {
  const separated = splitIndentedProse(body);
  let rest = separated.rest;
  const work = separated.body;

  const fence = /^ {0,3}(`{3,}|~{3,})json[ \t]*(?:\r?\n|$)/m.exec(work);
  const bounds = fence ? fenceBounds(work, fence) : undefined;
  const input = bounds ? work.slice(bounds.bodyStart, bounds.bodyEnd).trim() : "";
  const outMark = builtinMarkers(work, OUTPUT_MARK_RE)[0];
  const executing = /\*Executing on server/i.test(work);
  let outputRaw = "";
  let complete = false;
  if (outMark) {
    const output = splitOutputProse(work.slice(outMark.index! + outMark[0].length));
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
  const matches = builtinMarkers(text, HEADER_RE);
  if (matches.length === 0) {
    // Providers can deliver the tool header and its result in different text
    // parts. The result-only part must not expose its transport envelope.
    const imageResult = /^\s*(?:\*\*(?:Output|输出)\s*[:：]\*\*\s*)?\*\*`?analyze_image_result_summary`?\s*[:：]\*\*/i.exec(text);
    if (imageResult) {
      const { output, rest } = splitOutputProse(text.slice(imageResult[0].length));
      return [{ kind: "text", text: [formatImageAnalysisOutput(output), rest].filter(Boolean).join("\n\n") }];
    }
    return [{ kind: "text", text }];
  }

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

type ImageOutput = { text: string; truncated: boolean };

/** Decode known image-service envelopes, retaining received text if the server
 * truncates a container or an inner JSON string. Plain prose is never unescaped. */
function decodeImageOutput(value: unknown, allowTruncatedString = false, depth = 0): ImageOutput {
  if (depth > 8) return { text: summarizeValue(value), truncated: false };
  if (typeof value === "string") {
    const text = value.trim();
    try { return decodeImageOutput(JSON.parse(text), allowTruncatedString, depth + 1); } catch { /* Not a complete JSON value. */ }
    if (/^[\[{]/.test(text) || (allowTruncatedString && text.startsWith('"'))) {
      const partial = parsePartialJsonContainer(text, true);
      if (partial !== undefined) return { ...decodeImageOutput(partial, true, depth + 1), truncated: true };
    }
    // A native tool result may include a complete JSON value followed by logs.
    // Preserve that tail instead of treating it as part of the JSON envelope.
    const { output, rest } = splitOutputProse(text);
    if (rest) {
      const decoded = decodeImageOutput(output.trim(), allowTruncatedString, depth + 1);
      return { ...decoded, text: [decoded.text, rest].filter(Boolean).join("\n\n") };
    }
    return { text: formatToolOutput(text), truncated: false };
  }
  if (Array.isArray(value)) {
    const items = value.map(item => decodeImageOutput(item, allowTruncatedString, depth + 1));
    return { text: items.map(item => item.text).filter(Boolean).join("\n\n"), truncated: items.some(item => item.truncated) };
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object.text === "string") return decodeImageOutput(object.text, allowTruncatedString, depth + 1);
    if (Array.isArray(object.content)) return decodeImageOutput(object.content, allowTruncatedString, depth + 1);
  }
  return { text: summarizeValue(value), truncated: false };
}

export function formatImageAnalysisOutput(raw: string): string {
  const stripped = raw
    .replace(/^\s*\*\*(?:Output|输出)\s*[:：]\*\*\s*/i, "")
    .replace(new RegExp(`^\\s*${SUMMARY_MARK_RE.source}\\s*`, "i"), "")
    .trim();
  const result = decodeImageOutput(stripped);
  return result.truncated
    ? `${result.text}\n\n${t("图片分析结果不完整，仅显示已收到的内容。")}`
    : result.text;
}
