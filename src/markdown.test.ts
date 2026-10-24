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

test("settled code restores explicit and automatic highlighting between streamed renders", (t) => {
  const known = t.mock.method(hljs, "highlight");
  const automatic = t.mock.method(hljs, "highlightAuto");
  withoutDom(() => {
    const source = (language: string) => `\`\`\`${language}\nfunction greet() { return "hello"; }\n\`\`\``;
    renderMarkdown(source("javascript"), true);
    assert.match(renderMarkdown(source("javascript")), /<span class="hljs-/);
    assert.equal(known.mock.callCount(), 1);
    assert.equal(automatic.mock.callCount(), 0);
    for (const language of ["unknown-language", ""]) {
      assert.match(renderMarkdown(source(language)), /<span class="hljs-/);
    }
    assert.equal(automatic.mock.callCount(), 2);
    const beforeKnown = known.mock.callCount();
    assert.doesNotMatch(renderMarkdown(source("javascript"), true), /<span class="hljs-/);
    assert.equal(known.mock.callCount(), beforeKnown);
    assert.equal(automatic.mock.callCount(), 2);
  });
});

test("a highlighting failure preserves escaped code", (t) => {
  t.mock.method(hljs, "highlight", () => { throw new Error("broken grammar"); });
  withoutDom(() => {
    const html = renderMarkdown("```javascript\n<script>alert(1)</script>\n```");
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script/);
  });
});
