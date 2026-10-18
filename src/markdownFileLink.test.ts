import test from "node:test";
import assert from "node:assert/strict";
import { localMarkdownFileLink as parse } from "./markdownFileLink";
test("local Markdown links separate line ranges, anchors and queries without decoding filename delimiters twice", () => {
  assert.deepEqual(parse('./sample.ts#L12-L18'),{path:'./sample.ts',line:12,endLine:18});
  assert.deepEqual(parse('./sample.ts?raw=1#L12'),{path:'./sample.ts',line:12});
  assert.deepEqual(parse('./README.md#usage'),{path:'./README.md'});
  assert.deepEqual(parse('./a%23b%3Fc%2520.ts#L2'),{path:'./a#b?c%20.ts',line:2});
  assert.deepEqual(parse('C:\\work\\sample.ts#L2'),{path:'C:\\work\\sample.ts',line:2});
  assert.deepEqual(parse('./sample.ts#L20-L2'),{path:'./sample.ts'});
  for (const href of ['https://example.test/a','command:workbench.action.reloadWindow','//host/share','#usage','./bad%00.ts']) assert.equal(parse(href),null);
});
