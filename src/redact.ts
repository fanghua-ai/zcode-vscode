/**
 * Mask credentials in exported/shared text and error notifications.
 * Every pattern repeats a single character class or two disjoint alternatives, so matching stays linear.
 */
const REDACTED = "[REDACTED]";

const AUTH_NAMES = "(?:proxy-)?authorization";
const AUTH_TOKEN = String.raw`[^\s"',;}=\\]`;
// Usage counters (inputTokens, outputTokens, tokens) do not match these names thanks to the word boundaries.
const FIELD_NAMES = "api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|client[_-]?secret|secret|password|passwd|pwd|(?:set-)?cookie|(?:x-)?device[_-]?mid";
const SENSITIVE_FIELD = new RegExp(`^(?:${AUTH_NAMES}|${FIELD_NAMES})$`, "i");

/** A sensitive JSON field owns its whole value, including objects and arrays. */
export function isSensitiveField(name: string): boolean {
  return SENSITIVE_FIELD.test(name);
}

// Name, then a separator that may close the name's own quote (plain or backslash-escaped inside a JSON string).
// A value whose closing quote is missing (a truncated log line) is masked to the end of the line or text,
// instead of falling through to the unquoted rule that would stop at the first separator.
const QUOTE_END = String.raw`(?:(?=[\r\n])|$)`;
// Inline Authorization value: scheme and parameters. Tokens, =, ="quoted" or =\"escaped\" parameter values, a lone
// backslash, and spaces or commas that are followed by another token. A parameter value whose closing quote is
// missing (a truncated stderr line) is masked to the end of the line, so no tail of the credential survives.
const AUTH_VALUE = String.raw`(?:${AUTH_TOKEN}|="(?:[^"\\\r\n]|\\[^\r\n])*(?:"|\\?${QUOTE_END})|=\\"(?:[^\\\r\n]|\\[^"\r\n])*(?:\\"|\\?${QUOTE_END})|=|\\(?!")|[ \t]*,[ \t]*(?=${AUTH_TOKEN})|[ \t]+(?=${AUTH_TOKEN}))+`;
const quotedValue = (names: string): Array<[RegExp, string]> => [
  // "name": "value with \" escapes, spaces; and &"
  [new RegExp(String.raw`\b(${names})\b(["']?\s*[:=]\s*)"(?:[^"\\\r\n]|\\[^\r\n])*(?:"|\\?${QUOTE_END})`, "gi"), `$1$2"${REDACTED}"`],
  [new RegExp(String.raw`\b(${names})\b(["']?\s*[:=]\s*)'(?:[^'\\\r\n]|\\[^\r\n])*(?:'|\\?${QUOTE_END})`, "gi"), `$1$2'${REDACTED}'`],
  // JSON nested in a JSON string: {\"name\":\"value\"}
  [new RegExp(String.raw`\b(${names})\b(\\"\s*:\s*)\\"(?:[^\\\r\n]|\\[^"\r\n])*(?:\\"|\\?${QUOTE_END})`, "gi"), `$1$2\\"${REDACTED}\\"`],
];

const PATTERNS: Array<[RegExp, string]> = [
  // Authorization values carry a scheme plus parameters (Digest username="a", nonce=..., response=...),
  // so the whole value is masked, never just its first word.
  ...quotedValue(AUTH_NAMES),
  // A standalone header line: everything up to the end of the line.
  [new RegExp(String.raw`^([ \t]*${AUTH_NAMES}[ \t]*:[ \t]*)[^\r\n]+`, "gim"), `$1${REDACTED}`],
  // A header inside other text (curl -H 'Authorization: Digest ...', a JSON message string): the scheme and its
  // parameters only. Tokens, name="quoted" values and the commas or spaces between them are consumed; a bare
  // quote, ; or } ends the value, so a one-line JSON log keeps the fields after it.
  [new RegExp(String.raw`\b(${AUTH_NAMES})([ \t]*:[ \t]*)(?=[^\s"'\[,;}=])${AUTH_VALUE}`, "gi"), `$1$2${REDACTED}`],
  // authorization=... in a query string or form body stops at the next separator.
  [new RegExp(String.raw`\b(${AUTH_NAMES})(["']?\s*=\s*["']?)[^\s"'&,;]+`, "gi"), `$1$2${REDACTED}`],
  // Bearer tokens anywhere else.
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`],
  // OpenAI/Anthropic/DeepSeek style keys
  [/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED],
  // JSON Web Tokens
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // A plain Cookie header can contain several credentials separated by semicolons.
  [/\b((?:set-)?cookie[ \t]*:[ \t]*)[^\r\n]+/gi, `$1${REDACTED}`],
  // "password": "a b;c" / 'secret'='x&y' / {\"token\":\"x\"}: a quoted value is masked up to its closing quote.
  ...quotedValue(FIELD_NAMES),
  // Unquoted values (api_key=..., ?token=..., client_secret: ...) stop at the next separator, so passwords
  // with @, ! or # are masked whole. Every field is masked, numeric ones included: a bare number can be a credential.
  [new RegExp(String.raw`\b(${FIELD_NAMES})\b(["']?\s*[:=]\s*["']?)(?!\[REDACTED\])[^\s"'&,;}]+`, "gi"), `$1$2${REDACTED}`],
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

const ORGANIZATION_FIELDS = "(?:bigmodel[-_])?(?:org|organization|organisation)(?:s|[-_ ]?(?:id|name|hash))?";
const ORGANIZATION_FIELD = new RegExp(`^(?:${ORGANIZATION_FIELDS})$`, "i");

export function isOrganizationField(name: string): boolean {
  return ORGANIZATION_FIELD.test(name);
}

/** Mask scalar identifiers and whole organization objects in JSON or log fragments. */
export function redactOrganizations(text: string): string {
  const containers = new RegExp(String.raw`\b${ORGANIZATION_FIELDS}\b\\?["']?\s*[:=]\s*[\[{]`, "gi");
  let result = "", previous = 0;
  for (let match = containers.exec(text); match; match = containers.exec(text)) {
    const start = match.index + match[0].length - 1;
    const encoded = /\\["']\s*[:=]/.test(match[0]);
    let end = start, depth = 0, quote = "", escaped = false;
    while (end < text.length) {
      let char = text[end++];
      // One JSON-string layer may escape the fragment's structural quotes.
      if (encoded && char === "\\" && (text[end] === "\\" || text[end] === '"')) char = text[end++];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = "";
      } else if (char === '"' || char === "'") quote = char;
      else if (char === "{" || char === "[") depth++;
      else if ((char === "}" || char === "]") && --depth === 0) break;
    }
    result += text.slice(previous, start) + (encoded ? `\\"${REDACTED}\\"` : `"${REDACTED}"`);
    previous = end;
    containers.lastIndex = end;
  }
  result += text.slice(previous);
  for (const [pattern, replacement] of quotedValue(ORGANIZATION_FIELDS)) result = result.replace(pattern, replacement);
  return result
    .replace(new RegExp(String.raw`\b(${ORGANIZATION_FIELDS})\b(["']?\s*[:=]\s*)(?=[^\s"'\[{])[^\r\n"&,;}]+`, "gi"), `$1$2"${REDACTED}"`)
    .replace(/(\/(?:organizations?|orgs?)\/)[^/\s?\#"',;\\]+/gi, `$1${REDACTED}`)
    .replace(/\borg-[A-Za-z0-9_-]+\b/gi, REDACTED);
}
