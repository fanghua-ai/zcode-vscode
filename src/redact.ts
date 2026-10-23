/**
 * Mask credentials before text reaches the output channel, error notifications or the clipboard.
 * Every pattern repeats a single character class or two disjoint alternatives, so matching stays linear.
 */
const REDACTED = "[REDACTED]";

const AUTH_NAMES = "(?:proxy-)?authorization";
const AUTH_TOKEN = String.raw`[^\s"',;}=\\]`;
// Usage counters (inputTokens, outputTokens, tokens) do not match these names thanks to the word boundaries.
const FIELD_NAMES = "api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|client[_-]?secret|secret|password|passwd|pwd";

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
