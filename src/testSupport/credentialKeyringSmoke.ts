import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { CRED_KEYS, readCredentialsWithRetry, setDesktopCredentialBinary, v2Dir } from "../credentials";

async function main(): Promise<void> {
  const [, , binary, directory, home] = process.argv;
  // Keep the native keyring on the runner's real user profile.
  const requireNative = createRequire(__filename);
  requireNative("node:os").homedir = () => home;
  const binding = readdirSync(directory).find(file => /^keyring\..+\.node$/.test(file));
  assert.ok(binding, "Native keyring binding missing");
  const { Entry } = requireNative(path.join(directory, binding));
  const file = path.resolve(v2Dir(), "credentials.json");
  const account = createHash("sha256").update(file).digest("hex");
  const entry = new Entry("ZCode Credential Encryption", account, { linux: { store: "secret-service" } });
  const key = randomBytes(32);
  const fingerprint = createHash("sha256").update(key).digest("hex").slice(0, 24);
  const seal = (value: string, keyId = fingerprint) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const payload = [iv, cipher.getAuthTag(), encrypted].map(bytes => bytes.toString("base64url")).join(".");
    return `enc:v2:os:${keyId}:${payload}`;
  };

  setDesktopCredentialBinary(binary);
  entry.setPassword(key.toString("base64url"));
  try {
    writeFileSync(file, JSON.stringify({
      [CRED_KEYS.bigmodelAccessToken]: seal("fixture-bigmodel"),
      [CRED_KEYS.zaiAccessToken]: seal("fixture-zai"),
      [CRED_KEYS.zcodeJwtToken]: seal("fixture-jwt"),
      invalid: seal("fixture-invalid", "0".repeat(24)),
    }));
    const credentials = await readCredentialsWithRetry();
    assert.deepEqual(credentials, {
      [CRED_KEYS.bigmodelAccessToken]: "fixture-bigmodel",
      [CRED_KEYS.zaiAccessToken]: "fixture-zai",
      [CRED_KEYS.zcodeJwtToken]: "fixture-jwt",
    });
    console.log("Native keyring credential decryption passed");
  } finally {
    entry.deletePassword();
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
