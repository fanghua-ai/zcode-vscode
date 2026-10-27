import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SubagentEntry {
  name: string;
  description: string;
  source: "built-in" | "user" | "workspace" | "plugin";
  enabled?: boolean;
}

const validName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(name);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try { return object(JSON.parse(await fs.readFile(file, "utf8"))); } catch { return {}; }
}

function scalar(value: string): string {
  let quoted = "";
  let end = value.length;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if ((c === '"' || c === "'") && value[i - 1] !== "\\") quoted = quoted === c ? "" : quoted || c;
    if (!quoted && c === "#" && /\s/.test(value[i - 1] ?? "")) { end = i; break; }
  }
  const text = value.slice(0, end).trim();
  return ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
    ? text.slice(1, -1) : text;
}

async function readProfiles(root: string, source: "user" | "workspace", disabled: Set<string>): Promise<SubagentEntry[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const profiles = await Promise.all(entries.filter(entry => entry.isFile() && /\.(md|markdown)$/i.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name)).map(async entry => {
    const content = await fs.readFile(path.join(root, entry.name), "utf8").catch(() => "");
    const frontmatter = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(content)?.[1];
    if (!frontmatter) return undefined;
    let name = "", description = "";
    for (const line of frontmatter.split(/\r?\n/)) {
      const match = /^(name|description)\s*:\s*(.*)$/.exec(line);
      if (match?.[1] === "name") name = scalar(match[2]);
      if (match?.[1] === "description") description = scalar(match[2]).replace(/\\n/g, "\n");
    }
    if (!validName(name) || !description) return undefined;
    return { name, description, source, enabled: source !== "user" || !disabled.has(`user:user:${name.toLowerCase()}`) } satisfies SubagentEntry;
  }));
  return profiles.filter(entry => entry !== undefined);
}

/** Desktop stores local profiles in its configured ZCode root and workspace. */
export async function localSubagents(workspace: string, home = os.homedir()): Promise<SubagentEntry[]> {
  const config = await readJson(path.join(home, ".zcode", "cli", "config.json"));
  const storageConfig = object(config.storage);
  const configured = typeof storageConfig.dir === "string" ? storageConfig.dir.trim() : "";
  const storage = configured.startsWith("~/") ? path.join(home, configured.slice(2)) : configured ? path.resolve(configured) : path.join(home, ".zcode");
  const state = await readJson(path.join(storage, "v2", "agents-state.json"));
  const disabled = new Set<string>(Array.isArray(state?.disabledAgentIds) ? state.disabledAgentIds.filter((id: unknown): id is string => typeof id === "string") : []);
  const [users, workspaceAgents] = await Promise.all([
    readProfiles(path.join(storage, "agents"), "user", disabled),
    readProfiles(path.join(workspace, ".zcode", "agents"), "workspace", disabled),
  ]);
  return [
    { name: "general-purpose", description: "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.", source: "built-in" },
    { name: "Explore", description: "Read-only search agent for broad fan-out searches.", source: "built-in" },
    ...users, ...workspaceAgents,
  ];
}

/** The runtime catalog supplies canonical plugin names; add only unambiguous aliases. */
export function mergeSubagentCatalog(local: SubagentEntry[], rawPlugins: unknown): SubagentEntry[] {
  const byName = new Map<string, SubagentEntry>();
  const reserved = new Set(local.map(agent => agent.name.toLowerCase()));
  for (const agent of local) if (agent.enabled !== false) byName.set(agent.name.toLowerCase(), agent);
  const qualified: string[] = [];
  for (const value of Array.isArray(rawPlugins) ? rawPlugins : []) {
    if (!value || typeof value !== "object") continue;
    const plugin = value as { enabled?: unknown; subagentNames?: unknown; conflictingPluginIds?: unknown };
    if (plugin.enabled !== true || (Array.isArray(plugin.conflictingPluginIds) && plugin.conflictingPluginIds.length)) continue;
    for (const name of Array.isArray(plugin.subagentNames) ? plugin.subagentNames : []) {
      if (typeof name === "string" && validName(name) && name.includes(":")) qualified.push(name);
    }
  }
  const counts = new Map<string, number>();
  for (const name of qualified) {
    const bare = name.slice(name.indexOf(":") + 1).toLowerCase();
    counts.set(bare, (counts.get(bare) ?? 0) + 1);
  }
  for (const name of qualified) {
    const entry: SubagentEntry = { name, description: "", source: "plugin" };
    if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), entry);
    const bare = name.slice(name.indexOf(":") + 1);
    if (counts.get(bare.toLowerCase()) === 1 && !reserved.has(bare.toLowerCase()) && !byName.has(bare.toLowerCase())) {
      byName.set(bare.toLowerCase(), { ...entry, name: bare });
    }
  }
  return [...byName.values()];
}
