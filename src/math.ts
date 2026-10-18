import katex from "katex";
import type { TokenizerAndRendererExtension, Tokens } from "marked";

interface FormulaToken extends Tokens.Generic { text: string; display: boolean }
const cache = new Map<string, string>();

/** Leave incomplete formulas alone while streaming. Never parse currency/code as math. */
export function formulaToken(source: string, block = false): FormulaToken | undefined {
  const match = (block ? /^ {0,3}(\$\$|\\\[)/ : /^(\$\$|\\\[|\\\(|\$)/).exec(source);
  if (!match) return;
  const open = match[1];
  const display = open === "$$" || open === "\\[";
  const close = open === "\\[" ? "\\]" : open === "\\(" ? "\\)" : open;
  const begin = match[0].length;
  if (open === "$" && /\s|\$/.test(source[begin] ?? "")) return;
  let end = begin;
  while ((end = source.indexOf(close, end)) >= 0) {
    let escapes = 0;
    for (let at = end - 1; at >= 0 && source[at] === "\\"; at--) escapes++;
    if (escapes % 2 === 0) break;
    end += close.length;
  }
  if (end < 0) return;
  const text = source.slice(begin, end);
  if (!text.trim() || !display && text.includes("\n")) return;
  if (open === "$" && (/\s$/.test(text) || /[\d$]/.test(source[end + 1] ?? ""))) return;
  let length = end + close.length;
  if (block) {
    const rest = source.slice(length);
    if (rest && !/^[ \t]*(?:\n|$)/.test(rest)) return;
    length += /^[ \t]*(?:\n|$)/.exec(rest)?.[0].length ?? 0;
  }
  return { type: block ? "formulaBlock" : "formulaInline", raw: source.slice(0, length), text, display };
}

export function renderFormula(token: FormulaToken): string {
  const key = `${token.display ? "D" : "I"}:${token.text}`;
  const cached = cache.get(key);
  if (cached) return cached;
  let html: string;
  try {
    if (token.text.length > 16384) throw new Error("Formula too large");
    html = katex.renderToString(token.text, {
      displayMode: token.display, throwOnError: true, trust: false,
      strict: "ignore", maxExpand: 200, maxSize: 20,
    });
  } catch {
    // Unsupported or malformed input stays readable, including its delimiters.
    return token.raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  cache.set(key, html);
  return html;
}

export const formulaExtensions: TokenizerAndRendererExtension[] = [
  { name: "formulaBlock", level: "block", start: source => source.match(/^ {0,3}(?:\$\$|\\\[)/m)?.index,
    tokenizer: source => formulaToken(source, true), renderer: token => renderFormula(token as FormulaToken) },
  { name: "formulaInline", level: "inline", start: source => source.search(/\$|\\[([]/),
    tokenizer: source => formulaToken(source), renderer: token => renderFormula(token as FormulaToken) },
];
