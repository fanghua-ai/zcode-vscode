import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as vscode from "vscode";
import { upsertDesktopTask } from "./taskIndex";
import { ZCodeViewProvider } from "./extension";
const os = require("os") as typeof import("os");
const { DatabaseSync } = require("node:sqlite");

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-project-test-"));
  const home = os.homedir;
  os.homedir = () => root;
  const index = path.join(root, ".zcode/v2/tasks-index.sqlite");
  fs.mkdirSync(path.dirname(index), { recursive: true });
  const db = new DatabaseSync(index);
  // The project's real schema matters: include FKs, unique live names and CLI tree visibility.
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE hosts(host_id TEXT PRIMARY KEY,kind TEXT NOT NULL,position INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE projects(project_id TEXT PRIMARY KEY,host_id TEXT NOT NULL REFERENCES hosts(host_id),
      name TEXT NOT NULL,name_overridden INTEGER NOT NULL DEFAULT 0,position INTEGER NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,pinned_at INTEGER,deleted INTEGER NOT NULL DEFAULT 0,deleted_at INTEGER,
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX project_name ON projects(host_id,name) WHERE deleted=0;
    CREATE TABLE project_roots(project_id TEXT NOT NULL REFERENCES projects(project_id),root_path TEXT NOT NULL,
      position INTEGER NOT NULL,is_primary INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(project_id,root_path));
    CREATE TABLE tasks(workspace_key TEXT,workspace_path TEXT,workspace_identity TEXT,task_id TEXT,title TEXT,
      task_status TEXT,provider TEXT,mode TEXT,model TEXT,created_at INTEGER,updated_at INTEGER,last_unread_at INTEGER,
      pinned INTEGER DEFAULT 0,archived INTEGER DEFAULT 0,deleted INTEGER DEFAULT 0,title_overridden INTEGER DEFAULT 0,
      meta_json TEXT,searchable_text TEXT,host_id TEXT,root_path TEXT,project_id TEXT,
      cli_title TEXT,cli_title_source TEXT,cli_created_at INTEGER,cli_updated_at INTEGER,cli_deleted INTEGER,
      PRIMARY KEY(workspace_key,task_id));
    CREATE UNIQUE INDEX idx_tasks_host_task ON tasks(host_id,task_id);`);
  t.after(() => { db.close(); os.homedir = home; fs.rmSync(root, { recursive: true, force: true }); });
  const save = (workspacePath = "/work/repo", sessionId = "s1") =>
    upsertDesktopTask({ workspacePath, sessionId, title: "Hello", createdAt: 100, updatedAt: 200 });
  const row = (id = "s1") => db.prepare("SELECT * FROM tasks WHERE task_id=?").get(id);
  const project = (id: string, roots: string[], host = "local", name = id) => {
    db.prepare("INSERT OR IGNORE INTO hosts(host_id,kind) VALUES(?,'local')").run(host);
    db.prepare("INSERT INTO projects(project_id,host_id,name,position,created_at,updated_at) VALUES(?,?,?,0,1,1)").run(id, host, name);
    for (const [i, rootPath] of roots.entries()) db.prepare("INSERT INTO project_roots VALUES(?,?,?,?)").run(id, rootPath, i, i === 0 ? 1 : 0);
  };
  return { db, root, index, save, row, project };
}

test("a new plugin workspace gets one reusable desktop project and visible CLI facts", t => {
  const f = fixture(t);
  assert.equal(f.save(), true);
  const task = f.row();
  assert.equal(task.host_id, "local");
  assert.equal(task.root_path, "/work/repo");
  assert.equal(f.db.prepare("SELECT root_path FROM project_roots WHERE project_id=?").get(task.project_id).root_path, "/work/repo");
  assert.deepEqual({ ...f.db.prepare("SELECT name,name_overridden,deleted FROM projects").get() },
    { name: "repo", name_overridden: 0, deleted: 0 });
  // Mirror the desktop's readTree filter: a correct project_id alone is insufficient.
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM tasks WHERE provider='glm' AND host_id='local' AND project_id=? AND deleted=0 AND coalesce(cli_deleted,0)=0 AND cli_created_at IS NOT NULL").get(task.project_id).n, 1);
  assert.equal(task.cli_title, "Hello");
  assert.equal(task.cli_created_at, 100);
  assert.equal(f.save("/work/repo", "s2"), true);
  assert.equal(f.row("s2").project_id, task.project_id);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM projects").get().n, 1);
});

test("existing multi-root project and desktop metadata are reused without changes", t => {
  const f = fixture(t);
  f.project("existing", ["/another/root", "/work/repo"], "local", "My project");
  f.db.exec("UPDATE projects SET pinned=1,name_overridden=1");
  assert.equal(f.save(), true);
  assert.equal(f.row().project_id, "existing");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM projects").get().n, 1);
  assert.deepEqual({ ...f.db.prepare("SELECT name,pinned,name_overridden FROM projects").get() },
    { name: "My project", pinned: 1, name_overridden: 1 });
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM project_roots").get().n, 2);
});

test("ordinary legacy tasks are associated during synchronization without losing flags or saved CLI facts", t => {
  const f = fixture(t);
  f.project("existing", ["/work/repo"]);
  f.db.exec(`INSERT INTO tasks(workspace_key,workspace_path,task_id,title,pinned,archived,cli_title,cli_title_source,cli_created_at,cli_updated_at)
    VALUES('/work/repo','/work/repo','s1','My title',1,1,'Saved title','custom',50,150)`);
  assert.equal(f.save(), true);
  assert.equal(f.row().project_id, "existing");
  assert.equal(f.row().pinned, 1);
  assert.equal(f.row().archived, 1);
  assert.equal(f.row().cli_title, "Saved title");
  assert.equal(f.row().cli_created_at, 50);
  assert.equal(f.row().cli_updated_at, 150);
});

test("a moved task keeps its assigned project even when it is deleted", t => {
  const f = fixture(t);
  f.project("assigned", ["/another/root"]);
  f.project("matching", ["/work/repo"]);
  f.db.exec(`UPDATE projects SET deleted=1 WHERE project_id='assigned';
    INSERT INTO tasks(workspace_key,workspace_path,task_id,host_id,root_path,project_id)
    VALUES('/work/repo','/work/repo','s1','local','/work/repo','assigned')`);
  assert.equal(f.save(), true);
  assert.equal(f.row().project_id, "assigned");
  assert.equal(f.db.prepare("SELECT deleted FROM projects WHERE project_id='assigned'").get().deleted, 1);
});

test("new roots do not reuse deleted projects, remote projects, or parent-directory projects", t => {
  const f = fixture(t);
  f.project("deleted", ["/work/repo"]);
  f.db.exec("UPDATE projects SET deleted=1");
  f.project("remote", ["/work/repo"], "remote");
  f.project("parent", ["/work"]);
  assert.equal(f.save(), true);
  assert.ok(!["deleted", "remote", "parent"].includes(f.row().project_id));
  assert.equal(f.row().host_id, "local");
});

test("same directory names in different roots get distinct desktop projects", t => {
  const f = fixture(t);
  assert.equal(f.save("/one/repo", "one"), true);
  assert.equal(f.save("/two/repo", "two"), true);
  assert.notEqual(f.row("one").project_id, f.row("two").project_id);
  assert.equal(f.db.prepare("SELECT name FROM projects WHERE project_id=?").get(f.row("two").project_id).name, "repo (2)");
});

test("Windows case/separator variants reuse the registered project and prior task assignment", t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
  const f = fixture(t);
  f.project("registered", ["C:\\Work\\Repo"]);
  assert.equal(f.save("c:/work/repo", "old"), true);
  assert.equal(f.row("old").project_id, "registered");
  assert.equal(f.save("C:\\Work\\Repo", "new"), true);
  assert.equal(f.row("new").project_id, "registered");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM projects").get().n, 1);
});

test("project, root and task creation roll back together when association fails", t => {
  const f = fixture(t);
  f.db.exec("CREATE TRIGGER fail_project BEFORE UPDATE OF project_id ON tasks BEGIN SELECT RAISE(ABORT,'test write failure'); END");
  assert.equal(f.save(), false);
  for (const table of ["projects", "project_roots", "tasks", "hosts"]) {
    assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, `${table} leaked from failed transaction`);
  }
});

test("indexing a newly created plugin session makes it visible in the desktop project tree", t => {
  const f = fixture(t);
  const cliPath = path.join(f.root, ".zcode/cli/db/db.sqlite");
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  const cli = new DatabaseSync(cliPath);
  cli.exec(`CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,title_source TEXT,version TEXT,directory TEXT,path TEXT,time_updated INTEGER,time_title_updated INTEGER);
    INSERT INTO session(id,title,version) VALUES('s1','Hello','3.16.2')`);
  cli.close();
  const provider = new ZCodeViewProvider({ subscriptions: [] } as unknown as vscode.ExtensionContext);
  const state = provider as unknown as {
    workspacePath: string;
    client: { currentSessionId: string; currentTitle: string; currentMode: () => string };
    indexCurrentSession: () => void;
  };
  state.workspacePath = "/work/repo";
  state.client = { currentSessionId: "s1", currentTitle: "Hello", currentMode: () => "build" };
  state.indexCurrentSession();
  assert.ok(f.row().project_id);
  assert.ok(f.row().cli_created_at);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM projects").get().n, 1);
});

test("refreshing the plugin list associates an existing ordinary task with its workspace project", async t => {
  const f = fixture(t);
  f.project("registered", ["/work/repo"]);
  f.db.exec(`INSERT INTO tasks(workspace_key,workspace_path,task_id,host_id,root_path,project_id,title)
    VALUES('/work/repo','/work/repo','s1','local','/work/repo',NULL,'Hello')`);
  const provider = new ZCodeViewProvider({ subscriptions: [],
    workspaceState: { get: () => undefined }, globalState: { get: () => undefined },
  } as unknown as vscode.ExtensionContext);
  const state = provider as unknown as {
    workspacePath: string;
    client: { currentSessionId: string; listSessions: () => Promise<Array<{ sessionId: string; title: string }>> };
    refreshSessions: () => Promise<void>;
    post: () => void;
  };
  state.workspacePath = "/work/repo";
  state.client = { currentSessionId: "other", listSessions: async () => [{ sessionId: "s1", title: "Hello" }] };
  state.post = () => {};
  await state.refreshSessions();
  assert.equal(f.row().project_id, "registered");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM projects").get().n, 1);
});

function savedSession(f: ReturnType<typeof fixture>, archivedAt: number | null = null) {
  const file = path.join(f.root, ".zcode/cli/db/db.sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cli = new DatabaseSync(file);
  cli.exec(`CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,title_source TEXT,version TEXT,
    directory TEXT,path TEXT,time_created INTEGER,time_updated INTEGER,time_title_updated INTEGER,time_archived INTEGER)`);
  cli.prepare("INSERT INTO session(id,title,version,directory,time_created,time_updated,time_archived) VALUES('s1','Hello','3.16.2','/work/repo',25,50,?)").run(archivedAt);
  cli.close();
}

function listProvider(sessions: Array<{sessionId: string; title: string; createdAt?: number; updatedAt?: number; archivedAt?: number}>) {
  const provider = new ZCodeViewProvider({ subscriptions: [], workspaceState: { get: () => undefined },
    globalState: { get: () => undefined } } as unknown as vscode.ExtensionContext);
  const state = provider as unknown as {
    workspacePath: string;
    sessions: Array<{ sessionId: string }>;
    client: { currentSessionId: string; listSessions: () => Promise<typeof sessions> };
    post: () => void;
    refreshSessions: (includeArchived?: boolean) => Promise<void>;
  };
  state.workspacePath = "/work/repo";
  state.client = { currentSessionId: "other", listSessions: async () => sessions };
  state.post = () => {};
  return state;
}

test("Windows alternate spelling of the same session reuses its row under UNIQUE(host_id,task_id)", t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
  const f = fixture(t);
  assert.equal(f.save("c:/work/repo", "same"), true);
  const projectId = f.row("same").project_id;
  assert.equal(f.save("C:\\Work\\Repo", "same"), true);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM tasks").get().n, 1);
  assert.equal(f.row("same").workspace_key, "c:/work/repo");
  assert.equal(f.row("same").workspace_path, "c:/work/repo");
  assert.equal(f.row("same").project_id, projectId);
});

test("desktop reserved placeholders acquire their provider and real saved creation time", t => {
  const f = fixture(t);
  f.project("reserved", ["/work/repo"]);
  savedSession(f);
  f.db.exec(`INSERT INTO tasks(workspace_key,workspace_path,task_id,host_id,root_path,project_id,created_at,updated_at,cli_created_at)
    VALUES('/work/repo','/work/repo','s1','local','/work/repo','reserved',0,0,0)`);
  assert.equal(upsertDesktopTask({ workspacePath: "/work/repo", sessionId: "s1", title: "Hello" }), true);
  assert.equal(f.row().provider, "glm");
  assert.equal(f.row().created_at, 25);
  assert.equal(f.row().cli_created_at, 25);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM tasks WHERE provider='glm' AND cli_created_at>0 AND project_id='reserved'").get().n, 1);
});

test("a persisted CLI archive is preserved even when the indexing caller has no archive flag", t => {
  const f = fixture(t);
  savedSession(f, 100);
  assert.equal(f.save(), true);
  assert.equal(f.row().archived, 1);
});

for (const includeArchived of [false, true]) {
  test(`refresh preserves CLI-only archives and associates indexed archived legacy tasks (tab=${includeArchived})`, async t => {
    const f = fixture(t);
    f.project("registered", ["/work/repo"]);
    f.db.exec(`INSERT INTO tasks(workspace_key,workspace_path,task_id,title,archived)
      VALUES('/work/repo','/work/repo','old','Old archived',1)`);
    const state = listProvider([
      { sessionId: "cli-only", title: "CLI archived", archivedAt: 100, createdAt: 50, updatedAt: 100 },
      { sessionId: "old", title: "Old archived", createdAt: 50, updatedAt: 100 },
    ]);
    await state.refreshSessions(includeArchived);
    assert.equal(state.sessions.length, includeArchived ? 2 : 0);
    for (const id of ["cli-only", "old"]) {
      assert.equal(f.row(id).archived, 1);
      assert.equal(f.row(id).project_id, "registered");
      assert.equal(f.row(id).host_id, "local");
    }
  });
}
