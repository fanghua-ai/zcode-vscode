import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { localSubagents, mergeSubagentCatalog } from "./subagentCatalog";

test("subagent catalog respects local scopes, disabled users, plugin aliases and conflicts", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zcode-agents-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), storage = path.join(root, "storage"), workspace = path.join(root, "workspace");
  await Promise.all([mkdir(path.join(home, ".zcode", "cli"), { recursive: true }), mkdir(path.join(storage, "agents"), { recursive: true }), mkdir(path.join(storage, "v2"), { recursive: true }), mkdir(path.join(workspace, ".zcode", "agents"), { recursive: true })]);
  await writeFile(path.join(home, ".zcode", "cli", "config.json"), JSON.stringify({ storage: { dir: storage } }));
  await writeFile(path.join(storage, "v2", "agents-state.json"), JSON.stringify({ disabledAgentIds: ["user:user:disabled"] }));
  await writeFile(path.join(storage, "agents", "user.md"), '---\nname: reviewer\ndescription: "User reviewer"\n---\n');
  await writeFile(path.join(storage, "agents", "disabled.md"), '---\nname: disabled\ndescription: Hidden\n---\n');
  await writeFile(path.join(workspace, ".zcode", "agents", "project.md"), '---\nname: reviewer\ndescription: Project reviewer # comment\n---\n');
  const local = await localSubagents(workspace, home);
  const result = mergeSubagentCatalog(local, [
    { enabled: true, subagentNames: ["demo:worker", "demo:reviewer", "demo:shared", "demo:disabled"], conflictingPluginIds: [] },
    { enabled: true, subagentNames: ["other:shared"], conflictingPluginIds: [] },
    { enabled: false, subagentNames: ["off:hidden"] },
  ]);
  assert.equal(result.find(agent => agent.name === "reviewer")?.source, "workspace");
  assert.equal(result.find(agent => agent.name === "reviewer")?.description, "Project reviewer");
  assert.ok(result.some(agent => agent.name === "general-purpose"));
  assert.ok(result.some(agent => agent.name === "Explore"));
  assert.ok(result.some(agent => agent.name === "demo:worker"));
  assert.ok(result.some(agent => agent.name === "worker"));
  assert.ok(!result.some(agent => agent.name === "disabled" || agent.name === "shared" || agent.name === "off:hidden"));
});
