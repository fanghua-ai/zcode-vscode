import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { desktopVersion, resolveDesktopVersion, issueCategory, modelFailureDetails, redactHome, redactDiagnosticText } from "./diagnostics";

test("Diagnostics redact home only at directory boundaries and respect Windows casing", () => {
  assert.equal(redactHome("/home/alice/project", "/home/alice", "linux"), "~/project");
  assert.equal(redactHome("/home/alice2/project", "/home/alice", "linux"), "/home/alice2/project");
  assert.equal(redactHome("c:\\users\\Alice\\项目", "C:\\Users\\alice", "win32"), "~\\项目");
});

test("diagnostic exports mask credentials, organization fields and usernames across platforms", () => {
  const text = JSON.stringify({
    apiKey: "TEST-KEY", secret: "TEST-SECRET", password: "TEST-PASSWORD", Authorization: "Bearer TEST-TOKEN",
    orgId: "PRIVATE-ORG", organizationName: "Private Company", organization: { id: "PRIVATE-ID", name: "Private Name" },
    linux: "/home/linux-user/project", mac: "/Users/mac-user/project", windows: "C:\\Users\\win-user\\project",
    spaced: "/Users/User Name/project", custom: "/mnt/custom-user/work", otherPath: "/opt/ZCode/glm/zcode.cjs",
  });
  const exported = redactDiagnosticText(text, "/mnt/custom-user");
  assert.doesNotMatch(exported, /TEST-|PRIVATE-|Private|linux-user|mac-user|win-user|User Name|custom-user/);
  const report = JSON.parse(exported);
  assert.equal(report.linux, "~/project");
  assert.equal(report.mac, "~/project");
  assert.equal(report.windows, "~\\project");
  assert.equal(report.custom, "~/work");
  assert.equal(report.otherPath, "/opt/ZCode/glm/zcode.cjs");
  assert.equal(report.organization, "[REDACTED]");
});

test("diagnostic log fragments redact nested organizations, URLs and serialized Windows paths", () => {
  const text = 'failure {"organizations":[{"id":"PRIVATE-ID","name":"Private Company","nested":{"x":"}"}}],"code":403}\n'
    + 'org_name="Private Team" endpoint=https://example.test/organization/private-id/projects/p\n'
    + 'cwd=C:\\Users\\WinUser\\project\n' + JSON.stringify({ error: "C:\\Users\\OtherUser\\file" });
  const exported = redactDiagnosticText(text, "c:\\users\\winuser", "win32");
  assert.doesNotMatch(exported, /PRIVATE-ID|Private Company|Private Team|private-id|WinUser|OtherUser/);
  assert.match(exported, /"code":403/);
  assert.match(exported, /organization\/\[REDACTED\]\/projects\/p/);
  assert.equal(redactDiagnosticText(exported, "c:\\users\\winuser", "win32"), exported);
});

test("organization objects inside a serialized log message are masked without breaking its JSON", () => {
  const text = JSON.stringify({ message: JSON.stringify({ organization: { id: "PRIVATE-ID", name: 'Private "Team"' }, code: 403 }) });
  const exported = redactDiagnosticText(text, "/home/test");
  assert.doesNotMatch(exported, /PRIVATE-ID|Private|Team/);
  assert.deepEqual(JSON.parse(JSON.parse(exported).message), { organization: "[REDACTED]", code: 403 });
});

test("organization field variants and unquoted names with apostrophes are redacted", () => {
  const text = 'org_name=Private O\'Company\nOrganization ID: ORG-PRIVATE\n'
    + JSON.stringify({ "bigmodel-organization": "PRIVATE-TEAM", organisation_name: "Private Company" });
  const exported = redactDiagnosticText(text, "");
  assert.doesNotMatch(exported, /Private|Company|PRIVATE/);
  assert.equal(redactDiagnosticText(exported, ""), exported);
});

test("organization assignments inside JSON string values do not corrupt the exported report", () => {
  const exported = redactDiagnosticText(JSON.stringify({ error: "request failed orgId=PRIVATE-ORG", orgId: 12345 }), "");
  assert.doesNotMatch(exported, /PRIVATE-ORG|12345/);
  assert.equal(JSON.parse(exported).orgId, "[REDACTED]");
  assert.equal(redactDiagnosticText(exported, ""), exported);
});

for (const [key, value] of [
  ["secret", { value: "PRIVATE-SECRET" }],
  ["token", ["PRIVATE-TOKEN", { value: "PRIVATE-NESTED-TOKEN" }]],
  ["Authorization", { Bearer: "PRIVATE-AUTHORIZATION" }],
] as const) {
  test(`diagnostic exports replace the entire nested ${key} value and preserve JSON`, () => {
    const input = { diagnostic: { [key]: value, status: 403 }, ordinary: "preserved" };
    const exported = redactDiagnosticText(JSON.stringify(input), "");
    assert.doesNotMatch(exported, /PRIVATE-/);
    assert.deepEqual(JSON.parse(exported), {
      diagnostic: { [key]: "[REDACTED]", status: 403 }, ordinary: "preserved",
    });
    assert.equal(redactDiagnosticText(exported, ""), exported);
  });
}

test("sensitive field aliases replace scalars, objects and arrays without matching usage counters", () => {
  const input = { API_KEY: { value: "PRIVATE-KEY" }, accessToken: ["PRIVATE-ACCESS"], refresh_token: "PRIVATE-REFRESH",
    "proxy-authorization": { Basic: "PRIVATE-AUTH" }, password: { value: "PRIVATE-PASSWORD" },
    client_secret: ["PRIVATE-CLIENT"], inputTokens: 12, tokenCount: 3 };
  const exported = redactDiagnosticText(JSON.stringify(input), "");
  assert.doesNotMatch(exported, /PRIVATE-/);
  const report = JSON.parse(exported);
  for (const key of ["API_KEY", "accessToken", "refresh_token", "proxy-authorization", "password", "client_secret"]) {
    assert.equal(report[key], "[REDACTED]");
  }
  assert.equal(report.inputTokens, 12);
  assert.equal(report.tokenCount, 3);
});

test("Recent diagnostic issues contain categories, never error text or secrets", () => {
  assert.equal(issueCategory("sqlite error with api_key=secret"), "storage");
  assert.equal(issueCategory("snapshot failed with private conversation text"), "synchronization");
  assert.equal(issueCategory("credentials invalid token=secret"), "authentication");
  assert.equal(issueCategory("private text only"), "request");
});

test("Desktop version reads packaged ASAR metadata and rejects invalid headers", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-diagnostics-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const binary = path.join(root, "glm", "zcode.cjs");
  const content = Buffer.from(JSON.stringify({version: "3.14.4", token: "DO_NOT_EXPORT"}));
  const index = Buffer.from(JSON.stringify({files: {"package.json": {offset: "0", size: content.length}}}));
  const head = Buffer.alloc(16); head.writeUInt32LE(index.length + 8, 4); head.writeUInt32LE(index.length, 12);
  fs.writeFileSync(path.join(root, "app.asar"), Buffer.concat([head, index, content]));
  assert.equal(desktopVersion(binary), "3.14.4");
  const windowsPackage = Buffer.from(JSON.stringify({ version: "3.17.1.9553" }));
  const largeIndex = Buffer.from(JSON.stringify({
    files: { "package.json": { offset: "0", size: windowsPackage.length } },
    padding: " ".repeat(8 * 1024 * 1024),
  }));
  head.writeUInt32LE(largeIndex.length + 8, 4);
  head.writeUInt32LE(largeIndex.length, 12);
  fs.writeFileSync(path.join(root, "app.asar"), Buffer.concat([head, largeIndex, windowsPackage]));
  assert.equal(desktopVersion(binary), "3.17.1");
  head.writeUInt32LE(0xffffffff, 12);
  fs.writeFileSync(path.join(root, "app.asar"), head);
  assert.equal(desktopVersion(binary), null);
  assert.equal(desktopVersion(""), null);
});

test("Desktop version falls back to Windows executable metadata when the manifest is unreadable", async () => {
  const binary = String.raw`D:\ZCode\resources\glm\zcode.cjs`;
  const result = await resolveDesktopVersion(binary, "win32", async executable => {
    assert.equal(executable, String.raw`D:\ZCode\ZCode.exe`);
    return "3.17.1.9553\r\n3.17.1.9553\r\n";
  });
  assert.deepEqual(result, { appVersion: "3.17.1", source: "windows_executable" });
});

test("Model failure diagnostics preserve structured fields without exporting raw messages", () => {
  const failure = modelFailureDetails({
    code: "fault.provider.denied", source: "provider", recoverable: false,
    message: "request has been blocked due to unusual activity. PRIVATE_PAYLOAD",
  });
  assert.deepEqual(failure, {
    code: "fault.provider.denied", source: "provider", recoverable: false, reason: "provider_activity_block",
  });
  assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_PAYLOAD/);
});
