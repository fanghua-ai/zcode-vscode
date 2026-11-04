import { formulaExtensions } from "../math";
import { marked } from "marked";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";

marked.use({
  extensions: formulaExtensions,
  gfm: true,
  breaks: true,
});

// CommonMark's flanking rules treat CJK letters after `**` as intraword text,
// so a closing strong delimiter directly followed by Chinese is left literal.
// Keep Marked's normal tokenizer and retry only that case with the following
// CJK code point represented as punctuation in its delimiter-only mask. The
// actual source remains untouched, including the rendered text.
const defaultEmStrong = new marked.Tokenizer().emStrong;
const defaultDel = new marked.Tokenizer().del;
const cjkLetter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function maskCjkAdjacentStrongClosers(src: string, maskedSrc: string): string | undefined {
  if (!src.startsWith("**") || src.startsWith("***")) return undefined;
  const sourceOffset = maskedSrc.length - src.length;
  if (sourceOffset < 0) return undefined;

  let result = maskedSrc;
  for (let from = 2; ; ) {
    const at = src.indexOf("**", from);
    if (at < 0) break;
    const nextCodePoint = src.codePointAt(at + 2);
    const maskedAt = sourceOffset + at;
    if (nextCodePoint !== undefined && maskedSrc.startsWith("**", maskedAt)) {
      const next = String.fromCodePoint(nextCodePoint);
      if (cjkLetter.test(next)) {
        // Preserve UTF-16 offsets because Marked uses indexes into both strings.
        result = result.slice(0, maskedAt + 2) + ".".repeat(next.length) + result.slice(maskedAt + 2 + next.length);
      }
    }
    from = at + 2;
  }
  return result === maskedSrc ? undefined : result;
}

marked.use({
  tokenizer: {
    emStrong(src, maskedSrc, prevChar) {
      const token = defaultEmStrong.call(this, src, maskedSrc, prevChar);
      if (token) return token;
      const cjkMaskedSrc = maskCjkAdjacentStrongClosers(src, maskedSrc);
      return cjkMaskedSrc ? defaultEmStrong.call(this, src, cjkMaskedSrc, prevChar) : undefined;
    },
    del(src, maskedSrc, prevChar) {
      // A single tilde beside a number is an approximation/range marker.
      // Consume it before Marked can pair it across a sentence. Explicit
      // double-tilde strikethrough (including ~~123~~) keeps normal semantics.
      const singleTilde = src.startsWith("~") && !src.startsWith("~~");
      const digitBefore = !!prevChar && /^\d$/u.test(prevChar);
      const numberAfter = /^~[^\S\r\n]*[+−-]?(?:\d|\.\d)/u.test(src);
      if (singleTilde && (digitBefore || numberAfter)) {
        // Marked types tokenizer.del as returning only Del tokens, while its
        // lexer accepts any inline token from an override at this position.
        return { type: "text", raw: "~", text: "~" } as unknown as NonNullable<ReturnType<typeof defaultDel>>;
      }
      return defaultDel.call(this, src, maskedSrc, prevChar);
    },
  },
});

function renderCode({ text, lang }: { text: string; lang?: string }, streaming: boolean): string {
  const language = (lang || "").trim();
  let highlighted: string;
  // Re-running a highlighter over a growing code block dominates long replies.
  // Keep streamed code readable and escaped; highlight once the part settles.
  if (streaming) {
    highlighted = escapeHtml(text);
  } else {
    try {
      if (language && hljs.getLanguage(language)) {
        highlighted = hljs.highlight(text, { language }).value;
      } else {
        // Unknown languages stay escaped rather than guessing across every grammar.
        highlighted = escapeHtml(text);
      }
    } catch {
      highlighted = escapeHtml(text);
    }
  }
  const langClass = language ? ` language-${escapeHtml(language)}` : "";
  const label = language || "code";
  return `<div class="code-block"><div class="code-toolbar"><span class="code-lang">${escapeHtml(
    label
  )}</span><button class="copy-btn" type="button" data-copy="1">Copy</button></div><pre><code class="hljs${langClass}">${highlighted}</code></pre></div>`;
}

const renderer = new marked.Renderer();
renderer.code = (code) => renderCode(code, false);
const streamingRenderer = new marked.Renderer();
streamingRenderer.code = (code) => renderCode(code, true);

export function renderMarkdown(text: string, streaming = false): string {
  const html = marked.parse(text, {
    async: false,
    renderer: streaming ? streamingRenderer : renderer,
  }) as string;
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["target", "rel", "data-copy", "class"],
    ADD_TAGS: ["button"],
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
