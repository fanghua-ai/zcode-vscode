import test from "node:test";
import assert from "node:assert/strict";
import { formatToolOutput } from "./toolOutput";

test("web-reader summary objects render title, URL, and description instead of their JSON envelope", () => {
  const raw = JSON.stringify({
    webReader_result_summary: [{
      text: {
        title: "Example project",
        description: "Sample project description.",
        url: "https://example.test/project",
      },
    }],
  });

  const output = formatToolOutput(raw);
  assert.match(output, /Example project/);
  assert.match(output, /https:\/\/example\.test\/project/);
  assert.match(output, /Sample project description\./);
  assert.doesNotMatch(output, /webReader_result_summary|\[\{|"title"/);
});

test("nested MCP text blocks and provider summaries are decoded for different web tools", () => {
  const raw = JSON.stringify({
    content: [{
      type: "text",
      text: JSON.stringify({
        webSearchPrime_result_summary: [
          { text: { title: "First result", url: "https://example.com/one", snippet: "First snippet." } },
          { text: { title: "Second result", url: "https://example.com/two", snippet: "Second snippet." } },
        ],
      }),
    }],
  });

  const output = formatToolOutput(raw);
  assert.match(output, /First result/);
  assert.match(output, /Second result/);
  assert.match(output, /First snippet\./);
  assert.match(output, /Second snippet\./);
  assert.doesNotMatch(output, /webSearchPrime_result_summary|\[\{|"title"/);
});

test("plain MCP text content unwraps while unknown structured output remains complete", () => {
  assert.equal(formatToolOutput(JSON.stringify({ content: [{ type: "text", text: "Read complete." }] })), "Read complete.");
  const unknown = { result: { count: 2 }, success: true };
  assert.equal(formatToolOutput(JSON.stringify(unknown)), JSON.stringify(unknown, null, 2));
});

test("search-result lists and terminal streams stay readable without losing failures", () => {
  const results = formatToolOutput(JSON.stringify({ searchResults: [
    { title: "One", url: "https://example.com/one", snippet: "First." },
    { title: "Two", url: "https://example.com/two", snippet: "Second." },
  ] }));
  assert.match(results, /One[\s\S]*First\./);
  assert.match(results, /Two[\s\S]*Second\./);
  assert.doesNotMatch(results, /"searchResults"|"title"/);

  assert.equal(
    formatToolOutput(JSON.stringify({ stdout: "build started", stderr: "missing file", exitCode: 2 })),
    "build started\n\nstderr:\nmissing file\n\nexit code: 2",
  );
  assert.equal(formatToolOutput(JSON.stringify({ stdout: "", stderr: "", exitCode: 0 })), "",
    "successful silent shell commands should not expose the transport envelope");
});

test("plain and markdown result_summary labels both unwrap", () => {
  const summary = JSON.stringify([{ text: { title: "Page", url: "https://example.com", description: "Readable." } }]);
  for (const raw of [
    `webReader_result_summary: ${summary}`,
    `**webReader_result_summary:** ${summary}`,
    "**Output:**\n**`webReader_result_summary`:** " + summary,
  ]) {
    assert.match(formatToolOutput(raw), /Readable\./);
    assert.doesNotMatch(formatToolOutput(raw), /webReader_result_summary/);
  }
});

test("truncated web-reader JSON still exposes its complete summary fields", () => {
  const raw = '**webReader_result_summary:** [{"text":{"title":"Example News",' +
    '"description":"Sample news page.","url":"https://example.test/news/",' +
    '"content":"---\\n\\n![Image 1: Sample illustration “';
  const output = formatToolOutput(raw);
  assert.match(output, /Example News/);
  assert.match(output, /https:\/\/example\.test\/news\//);
  assert.match(output, /Sample news page\./);
  assert.doesNotMatch(output, /webReader_result_summary|"title"|"content"/);
});

test("complete JSON followed by tool log text is preserved instead of truncating the tail", () => {
  const raw = '{"stdout":"build started"}\nERROR: process killed';
  assert.equal(formatToolOutput(raw), raw);
});
