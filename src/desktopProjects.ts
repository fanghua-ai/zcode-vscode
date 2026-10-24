import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { sameWorkspacePath } from "./workspacePath";

interface ProjectDb {
  all(sql: string, values?: unknown[]): unknown[];
  get(sql: string, values?: unknown[]): unknown | null;
  run(sql: string, values?: unknown[]): unknown;
}

/** Called inside the task write transaction. Older desktops have no project catalog. */
export function syncDesktopProject(db: ProjectDb, workspacePath: string, sessionId: string, workspaceKeys: string[]): void {
  const tables = db.all("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('hosts','projects','project_roots')");
  if (tables.length !== 3) return;
  const columns = new Set((db.all("PRAGMA table_info(tasks)") as Array<{ name: string }>).map(row => row.name));
  if (!["host_id", "root_path", "project_id"].every(name => columns.has(name))) return;
  const scope = `workspace_key IN (${workspaceKeys.map(() => "?").join(",")}) AND task_id=?`;
  const values = [...workspaceKeys, sessionId];
  const current = db.get(`SELECT host_id FROM tasks WHERE ${scope} ORDER BY updated_at DESC LIMIT 1`, values) as { host_id?: string };
  if (current.host_id && current.host_id !== "local") return;
  // A desktop user may have moved the task or deleted its project. Preserve that decision.
  const assigned = db.get(`SELECT project_id FROM tasks WHERE ${scope} AND project_id IS NOT NULL
    AND (host_id IS NULL OR host_id='local') ORDER BY updated_at DESC LIMIT 1`, values) as { project_id: string } | null;
  let projectId = assigned?.project_id;
  if (!projectId) {
    // Match roots, not directory prefixes. Preserve desktop spelling and Windows path semantics.
    const roots = db.all(`SELECT p.project_id,r.root_path FROM projects p JOIN project_roots r USING(project_id)
      WHERE p.host_id='local' AND p.deleted=0 ORDER BY r.is_primary DESC,p.position,p.project_id`) as Array<{ project_id: string; root_path: string }>;
    projectId = roots.find(root => sameWorkspacePath(root.root_path, workspacePath))?.project_id;
    if (!projectId) {
      const base = (process.platform === "win32" ? path.win32 : path.posix).basename(workspacePath) || workspacePath;
      let name = base;
      for (let suffix = 2; db.get("SELECT 1 FROM projects WHERE host_id='local' AND name=? AND deleted=0", [name]); suffix++) {
        name = `${base} (${suffix})`;
      }
      projectId = randomUUID();
      const now = Date.now();
      db.run(`INSERT OR IGNORE INTO hosts(host_id,kind,position) VALUES('local','local',(SELECT count(*) FROM hosts))`);
      // Same ordering/default-name rules as the desktop's directory-open flow.
      db.run(`INSERT INTO projects(project_id,host_id,name,name_overridden,position,created_at,updated_at)
        VALUES(?,'local',?,0,(SELECT coalesce(min(position),1)-1 FROM projects WHERE host_id='local'),?,?)`, [projectId, name, now, now]);
      db.run("INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,0,1)", [projectId, workspacePath]);
    }
  }
  db.run(`UPDATE tasks SET host_id=coalesce(host_id,'local'),root_path=coalesce(root_path,workspace_path),
    project_id=coalesce(project_id,?) WHERE ${scope} AND (host_id IS NULL OR host_id='local')`, [projectId, ...values]);
  // New desktop trees exclude rows with no CLI facts. Initialize only missing facts;
  // subsequent desktop reconciliation remains authoritative for the saved session.
  if (columns.has("cli_created_at")) db.run(`UPDATE tasks SET
    cli_title=coalesce(cli_title,title),
    cli_title_source=coalesce(cli_title_source,CASE WHEN title_overridden=1 THEN 'custom' ELSE 'default' END),
    cli_created_at=CASE WHEN coalesce(cli_created_at,0)=0 THEN nullif(created_at,0) ELSE cli_created_at END,
    cli_updated_at=CASE WHEN coalesce(cli_updated_at,0)=0 THEN nullif(updated_at,0) ELSE cli_updated_at END,
    cli_deleted=coalesce(cli_deleted,deleted)
    WHERE ${scope} AND host_id='local'`, values);
}
