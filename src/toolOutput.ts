type SummaryResult = { found: true; value: unknown } | { found: false };

const SUMMARY_KEY_RE = /_result_summary$/i;
const SUMMARY_ASSIGNMENT_RE = /^\s*(?:\*\*)?`?([A-Za-z0-9_.-]+_result_summary)`?\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*/i;
const OUTPUT_LABEL_RE = /^\s*(?:\*\*)?(?:Output|输出)\s*[:：]\s*(?:\*\*)?\s*/i;

function parseJsonContainer(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

type PartialJsonResult = { value: unknown; complete: boolean };

/** Recover complete fields when a tool summary ends in the middle of JSON.
 * Image-service envelopes can also retain partial text, including an inner
 * JSON string. Other tools keep the conservative complete-field behavior. */
export function parsePartialJsonContainer(text: string, keepPartialStrings = false): unknown | undefined {
  const source = text.trim();
  if (!source.startsWith("{") && !source.startsWith("[") && !(keepPartialStrings && source.startsWith('"'))) return undefined;
  let index = 0;
  const skipWhitespace = () => { while (/\s/.test(source[index] ?? "")) index++; };
  const hasMembers = (value: unknown) =>
    Array.isArray(value) ? value.length > 0 : keepPartialStrings && typeof value === "string" ? value.length > 0
      : !!value && typeof value === "object" && Object.keys(value).length > 0;

  function parseString(): PartialJsonResult | undefined {
    if (source[index] !== '"') return undefined;
    index++;
    let value = "";
    while (index < source.length) {
      const char = source[index++]!;
      if (char === '"') return { value, complete: true };
      if (char !== "\\") { value += char; continue; }
      if (index >= source.length) break;
      const escaped = source[index++]!;
      const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (escaped in simple) value += simple[escaped];
      else if (escaped === "u" && /^[\da-f]{4}$/i.test(source.slice(index, index + 4))) {
        value += String.fromCharCode(parseInt(source.slice(index, index + 4), 16));
        index += 4;
      } else return { value, complete: false };
    }
    return { value, complete: false };
  }

  function parseValue(depth: number): PartialJsonResult | undefined {
    if (depth > 32) return undefined;
    skipWhitespace();
    const char = source[index];
    if (char === '"') return parseString();
    if (char === "{") {
      index++;
      const value: Record<string, unknown> = {};
      while (index < source.length) {
        skipWhitespace();
        if (source[index] === "}") { index++; return { value, complete: true }; }
        const key = parseString();
        if (!key?.complete || typeof key.value !== "string") return { value, complete: false };
        skipWhitespace();
        if (source[index] !== ":") return { value, complete: false };
        index++;
        const item = parseValue(depth + 1);
        if (!item) return { value, complete: false };
        if (item.complete || hasMembers(item.value)) value[key.value] = item.value;
        skipWhitespace();
        if (source[index] === ",") { index++; continue; }
        if (source[index] === "}") { index++; return { value, complete: true }; }
        return { value, complete: false };
      }
      return { value, complete: false };
    }
    if (char === "[") {
      index++;
      const value: unknown[] = [];
      while (index < source.length) {
        skipWhitespace();
        if (source[index] === "]") { index++; return { value, complete: true }; }
        const item = parseValue(depth + 1);
        if (!item) return { value, complete: false };
        if (item.complete || hasMembers(item.value)) value.push(item.value);
        skipWhitespace();
        if (source[index] === ",") { index++; continue; }
        if (source[index] === "]") { index++; return { value, complete: true }; }
        return { value, complete: false };
      }
      return { value, complete: false };
    }
    const start = index;
    while (index < source.length && !/[\s,}\]]/.test(source[index]!)) index++;
    const token = source.slice(start, index);
    if (token === "true") return { value: true, complete: true };
    if (token === "false") return { value: false, complete: true };
    if (token === "null") return { value: null, complete: true };
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) return { value: Number(token), complete: true };
    return undefined;
  }

  const parsed = parseValue(0);
  // Do not treat text after a complete JSON value as truncation. Tool streams
  // can contain a valid JSON prefix followed by important stdout/stderr logs.
  return parsed && !parsed.complete && index === source.length && hasMembers(parsed.value)
    ? parsed.value
    : undefined;
}

function hasReadableFields(value: unknown, depth = 0): boolean {
  if (depth > 12 || value == null) return false;
  if (Array.isArray(value)) return value.some(item => hasReadableFields(item, depth + 1));
  if (typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  const keys = ["title", "url", "href", "link", "description", "summary", "snippet", "excerpt", "markdown", "body", "content", "text", "stdout", "stdoutTail", "stderr", "stderrTail"];
  if (keys.some(key => typeof object[key] === "string" && !!(object[key] as string).trim())) return true;
  return Object.values(object).some(item => hasReadableFields(item, depth + 1));
}


function findResultSummary(value: unknown, depth = 0): SummaryResult {
  if (depth > 8) return { found: false };
  if (typeof value === "string") {
    const text = value.replace(OUTPUT_LABEL_RE, "").trim();
    const assignment = SUMMARY_ASSIGNMENT_RE.exec(text);
    if (assignment) {
      const payload = text.slice(assignment[0].length).trim();
      return { found: true, value: parseJsonContainer(payload) ?? payload };
    }
    const parsed = parseJsonContainer(text);
    const recovered = parsed ?? parsePartialJsonContainer(text);
    return recovered === undefined ? { found: false } : findResultSummary(recovered, depth + 1);
  }
  if (Array.isArray(value)) {
    const matches = value
      .map((item) => findResultSummary(item, depth + 1))
      .filter((item): item is Extract<SummaryResult, { found: true }> => item.found)
      .map((item) => item.value);
    if (!matches.length) return { found: false };
    return { found: true, value: matches.length === 1 ? matches[0] : matches };
  }
  if (!value || typeof value !== "object") return { found: false };

  const entries = Object.entries(value as Record<string, unknown>);
  const summaries = entries.filter(([key]) => SUMMARY_KEY_RE.test(key));
  if (summaries.length) {
    const values = summaries.map(([, item]) => item);
    return { found: true, value: values.length === 1 ? values[0] : values };
  }

  // MCP and other tool adapters wrap their useful text in content, text,
  // result, or structuredContent. Search those first, then any extension data.
  const preferred = ["structuredContent", "content", "text", "result", "output"];
  const ordered = [
    ...preferred.flatMap((key) => entries.filter(([name]) => name === key)),
    ...entries.filter(([name]) => !preferred.includes(name)),
  ];
  for (const [, item] of ordered) {
    const found = findResultSummary(item, depth + 1);
    if (found.found) return found;
  }
  return { found: false };
}

function textField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatValue(value: unknown, depth = 0): string {
  if (depth > 8 || value == null) return "";
  if (typeof value === "string") {
    const text = value.replace(OUTPUT_LABEL_RE, "").trim();
    const assignment = SUMMARY_ASSIGNMENT_RE.exec(text);
    if (assignment) {
      const payload = text.slice(assignment[0].length).trim();
      const parsed = parseJsonContainer(payload);
      return parsed === undefined ? payload : formatValue(parsed, depth + 1);
    }
    const parsed = parseJsonContainer(text);
    if (parsed !== undefined) return formatValue(parsed, depth + 1);
    const recovered = parsePartialJsonContainer(text);
    return recovered !== undefined && hasReadableFields(recovered)
      ? formatValue(recovered, depth + 1)
      : text;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => formatValue(item, depth + 1)).filter(Boolean).join("\n\n");
  if (typeof value !== "object") return String(value);

  const object = value as Record<string, unknown>;
  if (object.type === "text" && typeof object.text === "string") {
    return formatValue(object.text, depth + 1);
  }
  if (object.structuredContent != null) {
    const structured = formatValue(object.structuredContent, depth + 1);
    if (structured) return structured;
  }
  if (object.content != null) {
    const content = formatValue(object.content, depth + 1);
    if (content) return content;
  }
  for (const key of ["results", "searchResults", "items", "pages", "documents", "matches"]) {
    if (Array.isArray(object[key])) return formatValue(object[key], depth + 1);
  }

  const stdout = textField(object.stdout) ?? textField(object.stdoutTail);
  const stderr = textField(object.stderr) ?? textField(object.stderrTail);
  const exitCode = typeof object.exitCode === "number" ? object.exitCode : undefined;
  if (exitCode === 0 && !stdout && !stderr) return "";
  if (stdout || stderr || exitCode !== undefined) {
    const output = [
      stdout,
      ...(stderr ? [`stderr:\n${stderr}`] : []),
      ...(exitCode !== undefined && exitCode !== 0 ? [`exit code: ${exitCode}`] : []),
    ].filter(Boolean);
    if (output.length) return output.join("\n\n");
  }

  const title = textField(object.title);
  const url = textField(object.url) ?? textField(object.href) ?? textField(object.link) ?? textField(object.uri);
  const description = textField(object.description) ?? textField(object.summary) ?? textField(object.snippet) ?? textField(object.excerpt);
  const body = textField(object.markdown) ?? textField(object.body) ?? textField(object.content) ??
    (object.text == null ? undefined : textField(object.text) ?? formatValue(object.text, depth + 1));
  const lines = [title, url, description, body].filter((item): item is string => !!item);
  if (lines.length) return lines.join("\n\n");

  try {
    return JSON.stringify(object, null, 2);
  } catch {
    return String(value);
  }
}

/** Format structured output from built-in, MCP, and custom ZCode tools. */
export function formatToolOutput(raw: string): string {
  if (!raw.trim()) return "";
  const text = raw.replace(OUTPUT_LABEL_RE, "").trim();
  const summary = findResultSummary(text);
  return formatValue(summary.found ? summary.value : text);
}
