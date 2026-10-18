import test from "node:test";
import assert from "node:assert/strict";
import { Marked } from "marked";
import { formulaExtensions, formulaToken, renderFormula } from "./math";
const parser = new Marked({ extensions: formulaExtensions });

test("formulas support inline and block delimiters without markdown eating subscripts", () => {
  for (const source of [String.raw`$x_1^2$`, String.raw`\(\frac{1}{2}\)`, String.raw`$$\sum_{i=1}^n i$$`, String.raw`\[\begin{pmatrix}1&2\\3&4\end{pmatrix}\]`]) {
    const html = parser.parse(source) as string;
    assert.match(html, /class="katex"/);
    assert.match(html, /<math/);
    assert.doesNotMatch(html, /<em>/);
  }
});

test("streaming incomplete math and code or currency stay outside the math renderer", () => {
  for (const source of [String.raw`$x_1`, String.raw`\[x`, "cost $3 and $5", "`$x$`", "```latex\n$x$\n```", String.raw`escaped \$x\$`]) {
    assert.doesNotMatch(parser.parse(source) as string, /class="katex"/);
  }
  assert.match(parser.parse(String.raw`$x_1$`) as string, /class="katex"/);
});

test("invalid oversized and recursive formulas preserve escaped input without throwing", () => {
  for (const source of [String.raw`$\unknownCommand{x}$`, '$' + 'x'.repeat(17000) + '$', String.raw`$\def\a{\a}\a$`]) {
    const token = formulaToken(source)!;
    assert.ok(token);
    assert.doesNotThrow(() => renderFormula(token));
    assert.doesNotMatch(renderFormula(token), /class="katex"/);
  }
  assert.match(renderFormula(formulaToken('$\\unknown{<script>}$')!), /&lt;script&gt;/);
});

test("formula commands cannot create external images or trusted HTML", () => {
  for (const source of [String.raw`$\includegraphics{https://example.invalid/private}$`, String.raw`$\href{javascript:alert(1)}{click}$`, String.raw`$\htmlStyle{position:fixed}{x}$`]) {
    const html = renderFormula(formulaToken(source)!);
    assert.doesNotMatch(html, /<img|<a\b|style="position/);
  }
});
