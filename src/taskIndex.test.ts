import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { disposeSqliteSnapshots, listSessionQuestions, loadTaskFlags, setTaskArchived, setTaskDeleted } from "./taskIndex";

const os = require("os") as typeof import("os");
const loader = require("module") as { _load(name: string, ...args: unknown[]): unknown };
interface Database {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): Record<string, unknown> };
  close(): void;
}
interface NativeOptions { readOnly?: boolean; timeout?: number }
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (file: string, options?: NativeOptions) => Database;
};
const readonlyPosix = {
  skip: process.platform === "win32" || process.getuid?.() === 0 ? "requires POSIX permissions without root's bypass; Windows ACLs are covered by the host suite" : false,
};

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-native-sqlite-test-"));
  const originalHome = os.homedir, originalTmp = os.tmpdir;
  const temp = path.join(root, "temp");
  fs.mkdirSync(temp);
  os.homedir = () => root;
  os.tmpdir = () => temp;
  const index = path.join(root, ".zcode/v2/tasks-index.sqlite");
  const cli = path.join(root, ".zcode/cli/db/db.sqlite");
  fs.mkdirSync(path.dirname(index), { recursive: true });
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  t.after(() => {
    disposeSqliteSnapshots();
    os.homedir = originalHome;
    os.tmpdir = originalTmp;
    for (const dir of [path.dirname(index), path.dirname(cli)]) fs.chmodSync(dir, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, index, cli, temp };
}

function tasks(file: string): Database {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE tasks(workspace_key TEXT, task_id TEXT, archived INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0, updated_at INTEGER);
    INSERT INTO tasks(workspace_key,task_id) VALUES('/project','session');`);
  return db;
}

function questions(file: string): Database {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, time_archived INTEGER, time_updated INTEGER);
    INSERT INTO session(id) VALUES('session');
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, sequence INTEGER, data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, sequence INTEGER, data TEXT);`);
  return db;
}

function addQuestion(db: Database, id: string, sequence: number): void {
  db.prepare("INSERT INTO message VALUES(?, 'session', ?, ?, ?)")
    .run(id, 1700000000 + sequence, sequence, JSON.stringify({ role: "user" }));
  db.prepare("INSERT INTO part VALUES(?, ?, 1, ?)")
    .run(`part-${id}`, id, JSON.stringify({ type: "text", text: id }));
}

/** Observe the real native engine; any WASM load is a regression. */
function observeNative(t: TestContext, missing = false) {
  const opened: Array<{ file: string; options?: NativeOptions }> = [];
  let wasmLoads = 0;
  const original = loader._load;
  loader._load = function(name, ...args) {
    if (name.includes("node-sqlite3-wasm")) wasmLoads++;
    assert.equal(name.includes("node-sqlite3-wasm"), false, "storage attempted to load WASM SQLite");
    if (name === "node:sqlite") {
      if (missing) throw new Error("test runtime lacks node:sqlite");
      return { DatabaseSync: new Proxy(DatabaseSync, {
        construct(target, [file, options]: [string, NativeOptions?]) {
          opened.push({ file, options });
          const db = new target(file, { ...options, timeout: 1 });
          // Exercise real lock errors without waiting five seconds for each assertion.
          const exec = db.exec.bind(db);
          db.exec = sql => exec(sql.replace(/busy_timeout\s*=\s*5000/gi, "busy_timeout=1"));
          return db;
        },
      }) };
    }
    return original.call(this, name, ...args);
  };
  t.after(() => { loader._load = original; assert.equal(wasmLoads, 0, "storage attempted to load WASM SQLite"); });
  return opened;
}

function digest(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("native SQLite reads and durably updates ordinary task databases without snapshots", t => {
  const f = fixture(t), db = tasks(f.index);
  db.close();
  const opened = observeNative(t);
  assert.deepEqual(loadTaskFlags("/project"), { archived: [], deleted: [] });
  setTaskArchived("/project", "session", true);
  assert.deepEqual(loadTaskFlags("/project"), { archived: ["session"], deleted: [] });
  setTaskDeleted("/project", "session");
  const verify = new DatabaseSync(f.index);
  try {
    assert.deepEqual({ ...verify.prepare("SELECT archived,deleted FROM tasks").get() }, { archived: 0, deleted: 1 });
  } finally { verify.close(); }
  assert.ok(opened.length >= 4);
  assert.ok(opened.every(open => open.file === f.index));
  assert.deepEqual(fs.readdirSync(f.temp), []);
});

test("native WAL readers see committed JSON questions and exclude uncommitted messages", t => {
  let db!: Database;
  t.after(() => db?.close());
  const f = fixture(t);
  db = questions(f.cli);
  addQuestion(db, "baseline", 1);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  addQuestion(db, "committed", 2);
  db.exec("BEGIN");
  addQuestion(db, "pending", 3);
  const opened = observeNative(t);
  assert.deepEqual(listSessionQuestions("session").map(q => q.text), ["baseline", "committed"]);
  db.exec("COMMIT");
  assert.deepEqual(listSessionQuestions("session").map(q => q.text), ["baseline", "committed", "pending"]);
  assert.ok(opened.every(open => open.file === f.cli));
  assert.deepEqual(fs.readdirSync(f.temp), []);
});

test("read-only WAL without SHM uses cached native snapshots, invalidates them, and refuses writes", readonlyPosix, t => {
  let writer!: Database;
  t.after(() => writer?.close());
  const f = fixture(t);
  const source = path.join(f.root, "source.sqlite");
  writer = questions(source);
  addQuestion(writer, "baseline", 1);
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  addQuestion(writer, "wal-committed", 2);
  writer.exec("BEGIN");
  addQuestion(writer, "pending", 3);
  const publish = () => {
    fs.chmodSync(path.dirname(f.cli), 0o700);
    for (const suffix of ["", "-wal"]) {
      const file = f.cli + suffix;
      if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
      fs.copyFileSync(source + suffix, file);
      fs.chmodSync(file, 0o400);
    }
    fs.chmodSync(path.dirname(f.cli), 0o500);
  };
  publish();
  assert.equal(fs.existsSync(f.cli + "-shm"), false);
  const opened = observeNative(t);
  const expected = ["baseline", "wal-committed"];
  assert.deepEqual(listSessionQuestions("session").map(q => q.text), expected);
  const [first] = fs.readdirSync(f.temp);
  assert.ok(first, "no snapshot was materialized");
  assert.equal(fs.statSync(path.join(f.temp, first)).mode & 0o777, 0o600);
  assert.deepEqual(listSessionQuestions("session").map(q => q.text), expected);
  assert.deepEqual(fs.readdirSync(f.temp), [first], "an unchanged database rebuilt its snapshot");
  const snapshotOpens = () => opened.filter(open => path.dirname(open.file) === f.temp);
  assert.ok(snapshotOpens().length >= 2);
  assert.ok(snapshotOpens().every(open => open.options?.readOnly === true), "snapshots must only open read-only");

  const before = [digest(f.cli), digest(f.cli + "-wal")], beforeSnapshotOpens = snapshotOpens().length;
  assert.throws(() => setTaskArchived("/project", "session", true));
  assert.deepEqual([digest(f.cli), digest(f.cli + "-wal")], before, "a rejected write changed the source database");
  assert.equal(snapshotOpens().length, beforeSnapshotOpens, "a write was redirected to a snapshot");

  writer.exec("COMMIT");
  publish();
  assert.deepEqual(listSessionQuestions("session").map(q => q.text), [...expected, "pending"]);
  const [second, ...extra] = fs.readdirSync(f.temp);
  assert.ok(second);
  assert.notEqual(second, first, "a changed WAL reused stale data");
  assert.deepEqual(extra, [], "the old snapshot was not removed");
  disposeSqliteSnapshots();
  assert.deepEqual(fs.readdirSync(f.temp), []);
});

test("native SQLite preserves database lock errors instead of bypassing them with a snapshot", t => {
  let writer!: Database;
  t.after(() => writer?.close());
  const f = fixture(t);
  writer = tasks(f.index);
  writer.exec("BEGIN EXCLUSIVE; UPDATE tasks SET archived=1");
  const opened = observeNative(t);
  assert.deepEqual(loadTaskFlags("/project"), { archived: [], deleted: [] });
  assert.throws(() => setTaskArchived("/project", "session", false), /locked/i);
  assert.ok(opened.every(open => open.file === f.index));
  assert.deepEqual(fs.readdirSync(f.temp), []);
  writer.exec("ROLLBACK");
});

test("corrupt databases are rejected without constructing a misleading snapshot", t => {
  const f = fixture(t);
  fs.writeFileSync(f.index, "not a SQLite database");
  // A sidecar alone must not turn every SQLite error into a snapshot fallback.
  fs.writeFileSync(f.index + "-wal", "not a WAL");
  const opened = observeNative(t);
  assert.deepEqual(loadTaskFlags("/project"), { archived: [], deleted: [] });
  assert.throws(() => setTaskArchived("/project", "session", true), /not a database/i);
  assert.ok(opened.every(open => open.file === f.index));
  assert.deepEqual(fs.readdirSync(f.temp), []);
});

test("runtime without node:sqlite reports the runtime requirement and never loads WASM", t => {
  const f = fixture(t), db = tasks(f.index);
  db.close();
  observeNative(t, true);
  assert.throws(() => setTaskArchived("/project", "session", true), /SQLite.*VS Code|VS Code.*SQLite/);
  assert.deepEqual(fs.readdirSync(f.temp), []);
});

// A real desktop-like writer owns its connection in a separate process. Commands
// acknowledge transaction boundaries, so these tests do not depend on sleeps.
async function desktopWriter(file: string) {
  const child = spawn(process.execPath, ["-e", `
    const {DatabaseSync}=require('node:sqlite');
    const readline=require('node:readline');
    const db=new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    console.log('ready');
    readline.createInterface({input:process.stdin}).on('line', line=>{
      if(line==='stop'){db.close();process.exit(0);}
      db.exec(JSON.parse(line));console.log('done');
    });
  `, file], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const ready = await lines.next();
  assert.equal(ready.value, "ready", stderr);
  return {
    async exec(sql: string) {
      child.stdin.write(JSON.stringify(sql) + "\n");
      const reply = await lines.next();
      assert.equal(reply.value, "done", stderr);
    },
    async close() {
      child.stdin.end("stop\n");
      const [code] = await exited;
      assert.equal(code, 0, stderr);
    },
    async kill() { if (child.exitCode === null) { child.kill(); await exited; } },
  };
}

function questionSql(id: string, sequence: number): string {
  // Only fixed test identifiers are passed here.
  return `INSERT INTO message VALUES('${id}','session',${1700000000 + sequence},${sequence},'${JSON.stringify({ role: "user" })}');`
    + `INSERT INTO part VALUES('part-${id}','${id}',1,'${JSON.stringify({ type: "text", text: id })}');`;
}

test("successive refreshes follow another process's WAL commits and desktop restarts", { timeout: 15000 }, async t => {
  const f = fixture(t), db = questions(f.cli);
  addQuestion(db, "baseline", 1);
  db.close();
  let writer = await desktopWriter(f.cli);
  try {
    for (let i = 2; i <= 4; i++) {
      await writer.exec("BEGIN;" + questionSql(`message-${i}`, i));
      assert.equal(listSessionQuestions("session").length, i - 1, "uncommitted message leaked");
      await writer.exec("COMMIT");
      assert.deepEqual(listSessionQuestions("session").map(q => q.text),
        ["baseline", ...Array.from({ length: i - 1 }, (_, n) => `message-${n + 2}`)]);
    }
    await writer.close();
    assert.equal(listSessionQuestions("session").length, 4, "checkpoint/close lost history");
    writer = await desktopWriter(f.cli);
    await writer.exec(questionSql("after-restart", 5));
    assert.equal(listSessionQuestions("session").at(-1)?.text, "after-restart");
    await writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    assert.equal(listSessionQuestions("session").length, 5, "WAL truncation lost history");
    await writer.close();
  } finally { await writer.kill(); }
});
