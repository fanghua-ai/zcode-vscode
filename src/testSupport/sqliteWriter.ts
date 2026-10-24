const { DatabaseSync } = require("node:sqlite");
const [indexPath, cliPath, journal] = process.argv.slice(2);
const index = new DatabaseSync(indexPath), cli = new DatabaseSync(cliPath);
for (const db of [index, cli]) db.exec(`PRAGMA journal_mode=${journal}; PRAGMA wal_autocheckpoint=0`);
function insert(tag: string): void {
  index.prepare("INSERT INTO tasks(workspace_key,task_id,title,archived,deleted,updated_at) VALUES('/fixture',?,?,1,0,1)").run(tag, tag);
  cli.prepare("INSERT INTO message VALUES(?,'s1',?,10,?)")
    .run(tag, tag === "wal-second" ? 1700000011 : 1700000010, JSON.stringify({ role: "user" }));
  cli.prepare("INSERT INTO part VALUES(?,?,0,?)").run(tag + "-part", tag, JSON.stringify({ type: "text", text: tag }));
}
if (journal === "WAL") insert("wal-committed");
process.on("message", message => {
  try {
    if (message === "commit") {
      for (const db of [index, cli]) if (db.isTransaction) db.exec("ROLLBACK");
      insert("wal-second");
    }
    if (message === "hold") {
      for (const db of [index, cli]) db.exec("BEGIN IMMEDIATE");
      insert("uncommitted");
    }
    if (message === "exclusive") index.exec("BEGIN EXCLUSIVE");
    process.send?.({ ok: true });
  } catch (e) {
    process.send?.({ error: e instanceof Error ? e.message : String(e) });
  }
});
process.send?.({ ready: true });
export {};
