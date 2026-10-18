import assert from "node:assert/strict";
import test from "node:test";
import { withRuntimeCompileCache } from "./runtimeCache";

test("runtime cache preserves launch environment and honors explicit locations and opt-outs", () => {
  const env = { PATH: "test-path", ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "fixture.json" };
  const cached = withRuntimeCompileCache(env, "/isolated/cache");
  assert.deepEqual(cached, { ...env, NODE_COMPILE_CACHE: "/isolated/cache" });
  assert.equal(env.PATH, "test-path");
  assert.equal("NODE_COMPILE_CACHE" in env, false);
  const explicit = { ...env, NODE_COMPILE_CACHE: "/custom/cache" };
  assert.equal(withRuntimeCompileCache(explicit, "/isolated/cache"), explicit);
  const disabled = { ...env, NODE_DISABLE_COMPILE_CACHE: "1" };
  assert.equal(withRuntimeCompileCache(disabled, "/isolated/cache"), disabled);
  assert.equal(withRuntimeCompileCache(env), env);
});
