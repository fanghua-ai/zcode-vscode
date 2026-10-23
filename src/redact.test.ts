import assert from "node:assert/strict";
import test from "node:test";
import { redactSecrets } from "./redact";

test("common credential shapes are masked", () => {
  const cases: Array<[string, string]> = [
    ["Authorization: Bearer abcdefghijkl123", "Authorization: [REDACTED]"],
    ['{"authorization":"Basic dXNlcjpwYXNz"}', '{"authorization":"[REDACTED]"}'],
    ["curl -H 'bearer abcdefgh12345'", "curl -H 'bearer [REDACTED]'"],
    ["key sk-proj-AbCdEf0123456789 rejected", "key [REDACTED] rejected"],
    ["api_key=abcdef123456&x=1", "api_key=[REDACTED]&x=1"],
    ['{"apiKey": "abcdef123456"}', '{"apiKey": "[REDACTED]"}'],
    ["https://h/cb?token=abcdef123456", "https://h/cb?token=[REDACTED]"],
    ["client_secret: s3cr3t-value", "client_secret: [REDACTED]"],
    ["jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4", "jwt [REDACTED]"],
    ["password=p@ssw0rd!", "password=[REDACTED]"],
    ['{"password":"a#b$c%d^"}', '{"password":"[REDACTED]"}'],
    ["login user=x pwd=ab!c&next=1", "login user=x pwd=[REDACTED]&next=1"],
    ["{token: x!y}", "{token: [REDACTED]}"],
    ["secret=abc", "secret=[REDACTED]"],
    ["password=123456", "password=[REDACTED]"],
    ["pwd: 0000", "pwd: [REDACTED]"],
    ['{"secret":"98765"}', '{"secret":"[REDACTED]"}'],
    ["api_key=12345678", "api_key=[REDACTED]"],
    ['{"password":"abc;SECRET_SUFFIX"}', '{"password":"[REDACTED]"}'],
    ['{"password":"abc def"}', '{"password":"[REDACTED]"}'],
    ['{"password":"abc&def=1"}', '{"password":"[REDACTED]"}'],
    ['{"password":"a\\"b;c","next":1}', '{"password":"[REDACTED]","next":1}'],
    ["{'secret': 'x y;z'}", "{'secret': '[REDACTED]'}"],
    ['{"token":"12345678"}', '{"token":"[REDACTED]"}'],
    ["token: 42", "token: [REDACTED]"],
  ];
  for (const [input, expected] of cases) assert.equal(redactSecrets(input), expected, input);
});

test("authorization values are masked whole without swallowing neighbours", () => {
  const cases: Array<[string, string]> = [
    ['Authorization: Digest username="alice", realm="r", nonce="n0nce", uri="/", response="6629fae49393a053"\nHost: example.com',
      "Authorization: [REDACTED]\nHost: example.com"],
    ["  proxy-authorization: Basic dXNlcjpwYXNz\r\nAccept: */*", "  proxy-authorization: [REDACTED]\r\nAccept: */*"],
    ["Authorization: Bearer abc.def-123\nX-Next: keep", "Authorization: [REDACTED]\nX-Next: keep"],
    ["curl -H 'Authorization: Digest username=\"alice\", response=\"abc\"' https://h", "curl -H 'Authorization: [REDACTED]' https://h"],
    ['{"authorization":"Digest username=\\"alice\\", response=\\"abc\\"","next":"keep"}', '{"authorization":"[REDACTED]","next":"keep"}'],
    ['{"Proxy-Authorization": "Basic dXNlcjpwYXNz", "accept": "*/*"}', '{"Proxy-Authorization": "[REDACTED]", "accept": "*/*"}'],
    ["{'authorization': 'Bearer abc def'}", "{'authorization': '[REDACTED]'}"],
    ['body "{\\"authorization\\":\\"Digest username=alice, response=abc\\",\\"next\\":1}"',
      'body "{\\"authorization\\":\\"[REDACTED]\\",\\"next\\":1}"'],
    ['{"msg":"sent Authorization: Digest username=\\"alice\\", response=\\"abc\\"","next":"keep"}',
      '{"msg":"sent Authorization: [REDACTED]","next":"keep"}'],
    ['{"msg":"Authorization: Bearer abc","status":401,"next":"keep"}', '{"msg":"Authorization: [REDACTED]","status":401,"next":"keep"}'],
    ['log Authorization: Digest username="alice", response="abc"; retry=1', "log Authorization: [REDACTED]; retry=1"],
    ["https://h/cb?authorization=abc123&next=1", "https://h/cb?authorization=[REDACTED]&next=1"],
    ["retrying with bearer abcdefgh12345 now", "retrying with bearer [REDACTED] now"],
    ['body "{\\"password\\":\\"abc;def\\",\\"next\\":1}"', 'body "{\\"password\\":\\"[REDACTED]\\",\\"next\\":1}"'],
  ];
  for (const [input, expected] of cases) assert.equal(redactSecrets(input), expected, input);
});

test("quoted values cut off before their closing quote are masked to the end of the line", () => {
  const cases: Array<[string, string]> = [
    ['{"password":"abc;SECRET_SUFFIX', '{"password":"[REDACTED]"'],
    ['{"password":"abc def&x=1\n{"next":"keep"}', '{"password":"[REDACTED]"\n{"next":"keep"}'],
    ["secret='x y;z\r\nnext line", "secret='[REDACTED]'\r\nnext line"],
    ['{"token":"abc\\', '{"token":"[REDACTED]"'],
    ['{"authorization":"Digest username=\\"alice\\", response=\\"ab', '{"authorization":"[REDACTED]"'],
    ['body "{\\"password\\":\\"abc;def', 'body "{\\"password\\":\\"[REDACTED]\\"'],
  ];
  for (const [input, expected] of cases) assert.equal(redactSecrets(input), expected, input);
});

test("truncated inline Authorization headers are masked to the end of the line", () => {
  const cases: Array<[string, string]> = [
    ['[stderr] Authorization: Digest username="alice", response="ABC_SECRET_TAIL', "[stderr] Authorization: [REDACTED]"],
    ['[stderr] Proxy-Authorization: Digest username="alice", response="ABC_SECRET_TAIL\n[stderr] next line',
      "[stderr] Proxy-Authorization: [REDACTED]\n[stderr] next line"],
    ['{"msg":"Authorization: Digest username=\\"alice\\", response=\\"ABC_SECRET_TAIL', '{"msg":"Authorization: [REDACTED]'],
    // A quote after the value closes the surrounding string; the rest of the line stays.
    ['curl -H "Authorization: Bearer FAKE_TOKEN_123" https://api.example.invalid/v1/models',
      'curl -H "Authorization: [REDACTED]" https://api.example.invalid/v1/models'],
    ['{"level":"warn","msg":"Authorization: Bearer FAKE_TOKEN_123"}', '{"level":"warn","msg":"Authorization: [REDACTED]"}'],
    // Complete values next to other JSON fields still stop at the closing quote.
    ['{"msg":"Authorization: Digest username=\\"a\\", response=\\"b\\"","next":"keep"}', '{"msg":"Authorization: [REDACTED]","next":"keep"}'],
    ['{\\"msg\\":\\"Authorization: Bearer abc\\",\\"next\\":1}', '{\\"msg\\":\\"Authorization: [REDACTED]\\",\\"next\\":1}'],
  ];
  for (const [input, expected] of cases) assert.equal(redactSecrets(input), expected, input);
});

test("ordinary log text is left alone", () => {
  for (const text of [
    '{"inputTokens":1234,"outputTokens":56}',
    '{"usage":{"input_tokens":12,"output_tokens":3,"total_tokens":15}}',
    "maxTokens=4096 tokenCount: 7",
    "tokens: 1200 used",
    "app-server exited {\"code\":1}",
    "Cannot find module 'sk'",
    "password reset not supported",
    "authorization failed for user",
    "Authorization header missing",
  ]) assert.equal(redactSecrets(text), text);
});

test("long pathological input stays fast", () => {
  const input = "authorization=" + "a".repeat(200_000) + " bearer " + "-".repeat(200_000) + " sk-" + "x".repeat(200_000) +
    " password=" + "@".repeat(200_000) + " token:".repeat(50_000) +
    ' password:"'.repeat(50_000) + " Authorization:".repeat(50_000) + ' {\\"authorization\\":\\"'.repeat(20_000) + ' x Authorization: a="'.repeat(20_000) + " secret='" + "\\".repeat(200_000);
  const start = Date.now();
  redactSecrets(input);
  assert.ok(Date.now() - start < 1000);
});
