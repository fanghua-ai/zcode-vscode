import test from "node:test";
import assert from "node:assert/strict";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";
import { renderMarkdown } from "./webview/markdown";

// DOMPurify needs a browser document. The browser smoke tests exercise its real
// HTML cleaning; these tests inspect the code renderer's input to that boundary.
function withoutDom(run: () => void): void {
  const sanitize = DOMPurify.sanitize;
  DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;
  try {
    run();
  } finally {
    DOMPurify.sanitize = sanitize;
  }
}

test("streaming code skips known and automatic highlighting, including open fences", (t) => {
  const known = t.mock.method(hljs, "highlight");
  const automatic = t.mock.method(hljs, "highlightAuto");
  withoutDom(() => {
    for (const fence of ["javascript", "unknown-language", ""]) {
      const html = renderMarkdown(`\`\`\`${fence}\nconst x = "<img src=x onerror=alert(1)>";`, true);
      assert.match(html, /class="code-block"/);
      assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
      assert.doesNotMatch(html, /<span class="hljs-/);
      assert.doesNotMatch(html, /<img/);
    }
    assert.equal(known.mock.callCount(), 0);
    assert.equal(automatic.mock.callCount(), 0);
  });
});

test("settled code highlights explicit languages and leaves unknown languages escaped", (t) => {
  const known = t.mock.method(hljs, "highlight");
  const automatic = t.mock.method(hljs, "highlightAuto");
  withoutDom(() => {
    const source = (language: string) => `\`\`\`${language}\nfunction greet() { return "hello"; }\n\`\`\``;
    renderMarkdown(source("javascript"), true);
    assert.match(renderMarkdown(source("javascript")), /<span class="hljs-/);
    assert.equal(known.mock.callCount(), 1);
    assert.equal(automatic.mock.callCount(), 0);
    for (const language of ["unknown-language", ""]) {
      const html = renderMarkdown(source(language));
      assert.doesNotMatch(html, /<span class="hljs-/);
      assert.match(html, /class="code-block"/);
      assert.match(html, /data-copy="1"/);
    }
    assert.equal(automatic.mock.callCount(), 0);
    const beforeKnown = known.mock.callCount();
    assert.doesNotMatch(renderMarkdown(source("javascript"), true), /<span class="hljs-/);
    assert.equal(known.mock.callCount(), beforeKnown);
    assert.equal(automatic.mock.callCount(), 0);
  });
});

test("unlabelled and unsupported code escapes HTML without automatic highlighting", (t) => {
  const automatic = t.mock.method(hljs, "highlightAuto", () => { throw new Error("must not guess"); });
  withoutDom(() => {
    for (const language of ["", "unsupported-language"]) {
      const html = renderMarkdown("```" + language + "\n<script>alert(1)</script>\n```");
      assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.doesNotMatch(html, /<script/);
      assert.match(html, /data-copy="1"/);
    }
  });
  assert.equal(automatic.mock.callCount(), 0);
});

test("a highlighting failure preserves escaped code", (t) => {
  t.mock.method(hljs, "highlight", () => { throw new Error("broken grammar"); });
  withoutDom(() => {
    const html = renderMarkdown("```javascript\n<script>alert(1)</script>\n```");
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script/);
  });
});

test("backticks in inline code and fenced content do not add a synthetic fence", () => {
  withoutDom(() => {
    for (const streaming of [false, true]) {
      const inline = renderMarkdown("Inline triple ticks: ` ``` `", streaming);
      assert.equal(inline.trim(), "<p>Inline triple ticks: <code>```</code></p>");
      for (const source of [
        '```javascript\nconst fence = "```";\n```',
        '````markdown\n```javascript\nconst x = 1;\n````',
      ]) {
        const html = renderMarkdown(source, streaming);
        assert.equal(html.match(/class="code-block"/g)?.length, 1);
        assert.match(html, /```/);
      }
    }
  });
});

test("native Markdown handles open backtick and tilde fences without changing their text", () => {
  withoutDom(() => {
    for (const marker of ["```", "~~~~", "````"]) {
      const html = renderMarkdown(marker + 'javascript\nconst text = "<tag>";', true);
      assert.equal(html.match(/class="code-block"/g)?.length, 1);
      assert.match(html, /const text = &quot;&lt;tag&gt;&quot;;/);
      assert.doesNotMatch(html, /hljs-keyword/);
    }
  });
});


test("Chinese strong delimiters support quoted openers and adjacent closers without rewriting escapes or code", () => {
  withoutDom(() => {
    for (const streaming of [false, true]) {
      const text='结论先行：我的建议是**“规则升级 + 一个只读校验器”为主，机制只加一个可选项**——目标是把静默失败变成响亮失败。';
      assert.match(renderMarkdown(text,streaming), /我的建议是<strong>“规则升级 \+ 一个只读校验器”为主，机制只加一个可选项<\/strong>——/);
      assert.match(renderMarkdown('建议是**“规则升级”**然后验证',streaming), /是<strong>“规则升级”<\/strong>然后/);
      assert.doesNotMatch(renderMarkdown(String.raw`建议是\*\*“原样显示”\*\*`,streaming), /<strong>/);
      assert.doesNotMatch(renderMarkdown('`建议是**“代码”**`',streaming), /<strong>/);
      assert.doesNotMatch(renderMarkdown('word**“quoted”**',streaming), /<strong>/);
    }
  });
});
