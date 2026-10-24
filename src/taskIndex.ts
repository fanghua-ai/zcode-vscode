import { syncDesktopProject } from "./desktopProjects";
import { sameWorkspacePath } from "./workspacePath";
import { LocalizedError } from "./i18n";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { logDebug, logWarn } from "./log";

export interface DesktopTask {
  workspacePath: string;
  sessionId: string;
  title: string;
  model?: string;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
  /** A listed CLI session may already be archived before its desktop index exists. */
  archived?: boolean;
  /** User renamed this task; do not let generated titles overwrite it. */
  overrideTitle?: boolean;
  /** Permission mode. Omitted values keep the row the desktop already stored. */
  mode?: string;
}

/** One database was saved; repeating the same operation completes synchronization. */
export class SessionSyncError extends LocalizedError {}

interface SqliteApi {
  exec(sql: string): void;
  all(sql: string, values?: unknown[]): unknown[];
  get(sql: string, values?: unknown[]): unknown | null;
  run(sql: string, values?: unknown[]): unknown;
  close(): void;
}

/** Match legacy desktop keys without changing Linux's case-sensitive identity. */
function matchingWorkspaceKeys(db: SqliteApi, workspacePath: string): string[] {
  if (process.platform !== "win32") return [workspacePath];
  const rows = db.all("SELECT DISTINCT workspace_key FROM tasks") as Array<{ workspace_key: string }>;
  return [...new Set([workspacePath, ...rows.map(r => r.workspace_key).filter(k => typeof k === "string" && sameWorkspacePath(k, workspacePath))])];
}

function workspacePredicate(db: SqliteApi, workspacePath: string): { sql: string; values: string[] } {
  const values = matchingWorkspaceKeys(db, workspacePath);
  return { sql: `workspace_key IN (${values.map(() => "?").join(",")})`, values };
}

/** Include CLI-only paths too: server-side session/list uses exact directory matching. */
export function listWorkspacePathVariants(workspacePath: string): string[] {
  if (process.platform !== "win32") return [workspacePath];
  const variants = new Set([workspacePath]);
  for (const [file, sql, column] of [
    [tasksIndexPath(), "SELECT DISTINCT workspace_key FROM tasks", "workspace_key"],
    [sessionDbPath(), "SELECT DISTINCT directory FROM session", "directory"],
  ]) {
    if (!fs.existsSync(file)) continue;
    try {
      withDb(file, db => {
        for (const row of db.all(sql) as Array<Record<string, string>>) {
          const value = row[column];
          if (typeof value === "string" && sameWorkspacePath(value, workspacePath)) variants.add(value);
        }
      });
    } catch (e) { logWarn("Failed to read workspace path variants", e); }
  }
  return [...variants];
}

function tasksIndexPath(): string {
  return path.join(os.homedir(), ".zcode", "v2", "tasks-index.sqlite");
}

function sessionDbPath(): string {
  return path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
}

export interface SessionQuestion {
  id: string;
  text: string;
  /** Message creation time in milliseconds. */
  at?: number;
}

function questionTimeMs(raw: unknown): number | undefined {
  const value =
    typeof raw === "number" ? raw :
    typeof raw === "bigint" ? Number(raw) :
    typeof raw === "string" && raw.trim() ? Number(raw) :
    NaN;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
}

export function sessionsFinishedSince(
  marks: Array<{ sessionId: string; since: number }>
): string[] {
  const dbPath = sessionDbPath();
  if (!marks.length || !fs.existsSync(dbPath)) return [];
  try {
    return withDb(dbPath, (db) => {
      const done: string[] = [];
      for (const mark of marks) {
        if (!mark.sessionId || !mark.since) continue;
        const row = db.get(
          `select started_at as startedAt, completed_at as completedAt
           from turn_usage
           where session_id = ?
           order by started_at desc
           limit 1`,
          [mark.sessionId]
        ) as { startedAt?: number; completedAt?: number } | null;
        if (row?.completedAt && row.completedAt >= mark.since) done.push(mark.sessionId);
      }
      return done;
    });
  } catch (e) {
    logWarn("Could not refresh running sessions", e);
    return [];
  }
}
export function listSessionQuestions(sessionId: string): SessionQuestion[] {
  const dbPath = sessionDbPath();
  if (!sessionId || !fs.existsSync(dbPath)) return [];
  try {
    return withDb(dbPath, (db) => {
      const rows = db.all(
        `select m.id as id, m.time_created as at, p.data as data
         from message m
         join part p on p.message_id = m.id
         where m.session_id = ?
           and json_extract(m.data, '$.role') = 'user'
           and json_extract(p.data, '$.type') = 'text'
         order by m.time_created, coalesce(m.sequence, 0), coalesce(p.sequence, 0)`,
        [sessionId]
      ) as Array<{ id?: string; at?: unknown; data?: string }>;
      const order: string[] = [];
      const text = new Map<string, string>();
      const times = new Map<string, number>();
      for (const row of rows) {
        const id = String(row.id || "");
        if (!id) continue;
        let partText = "";
        try {
          const part = JSON.parse(String(row.data || "{}")) as {
            text?: string;
            synthetic?: boolean;
          };
          if (part.synthetic) continue;
          partText = String(part.text || "");
        } catch {
          continue;
        }
        if (!partText) continue;
        if (!text.has(id)) {
          order.push(id);
          const at = questionTimeMs(row.at);
          if (at) times.set(id, at);
        }
        text.set(id, (text.get(id) || "") + partText);
      }
      return order
        .map((id) => {
          const item: SessionQuestion = { id, text: (text.get(id) || "").replace(/\s+/g, " ").trim() };
          const at = times.get(id);
          if (at) item.at = at;
          return item;
        })
        .filter((item) => item.text);
    });
  } catch (e) {
    logWarn("Could not list session questions", e);
    return [];
  }
}

function bindArgs(values?: unknown[]): unknown[] {
  return Array.isArray(values) ? values : [];
}

function wrapNative(db: {
  exec(sql: string): void;
  prepare(sql: string): {
    all: (...args: unknown[]) => unknown[];
    get: (...args: unknown[]) => unknown;
    run: (...args: unknown[]) => unknown;
  };
  close(): void;
}): SqliteApi {
  return {
    exec: (sql) => db.exec(sql),
    all: (sql, values) => db.prepare(sql).all(...bindArgs(values)),
    get: (sql, values) => db.prepare(sql).get(...bindArgs(values)) ?? null,
    run: (sql, values) => db.prepare(sql).run(...bindArgs(values)),
    close: () => db.close(),
  };
}

function openNativeSqlite(dbPath: string, readOnly = false): SqliteApi {
  let DatabaseSync: new (
    filename: string, options?: { timeout?: number; readOnly?: boolean }
  ) => Parameters<typeof wrapNative>[0];
  try {
    DatabaseSync = require("node:sqlite").DatabaseSync;
    if (typeof DatabaseSync !== "function") throw new Error("DatabaseSync is unavailable");
  } catch (e) {
    throw new LocalizedError("当前 VS Code 运行环境不支持原生 SQLite，请更新 VS Code 后重试。", {}, { cause: e });
  }
  const db = new DatabaseSync(dbPath, { timeout: 5000, readOnly });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    // A real read surfaces WAL/permission errors before business queries, while recovery can still run.
    db.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
    return wrapNative(db);
  } catch (e) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    throw e;
  }
}

function pageSizeFromHeader(header: Buffer): number {
  const raw = header.readUInt16BE(16);
  return raw === 1 ? 65536 : raw;
}

function walChecksum(
  buf: Buffer,
  start: number,
  length: number,
  little: boolean,
  s1: number,
  s2: number
): [number, number] {
  const end = start + length;
  for (let i = start; i < end; i += 8) {
    const x = little ? buf.readUInt32LE(i) : buf.readUInt32BE(i);
    const y = little ? buf.readUInt32LE(i + 4) : buf.readUInt32BE(i + 4);
    s1 = (s1 + x + s2) >>> 0;
    s2 = (s2 + y + s1) >>> 0;
  }
  return [s1, s2];
}

/** Replay committed WAL frames into a rollback-journal copy that needs no shared-memory file. */
function applyWal(main: Buffer, wal: Buffer): Buffer {
  if (wal.length < 32) return Buffer.from(main);
  const magic = wal.readUInt32BE(0);
  const little = magic === 0x377f0682;
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return Buffer.from(main);
  if (wal.readUInt32BE(4) !== 3007000) return Buffer.from(main);
  const walPageSize = wal.readUInt32BE(8);
  const pageSize = walPageSize || pageSizeFromHeader(main);
  if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) return Buffer.from(main);
  const salt1 = wal.readUInt32BE(16);
  const salt2 = wal.readUInt32BE(20);
  let [s1, s2] = walChecksum(wal, 0, 24, little, 0, 0);
  if (s1 !== wal.readUInt32BE(24) || s2 !== wal.readUInt32BE(28)) return Buffer.from(main);

  const frameSize = 24 + pageSize;
  const frames: { page: number; dbPages: number; data: Buffer }[] = [];
  let offset = 32;
  while (offset + frameSize <= wal.length) {
    const page = wal.readUInt32BE(offset);
    const dbPages = wal.readUInt32BE(offset + 4);
    const fSalt1 = wal.readUInt32BE(offset + 8);
    const fSalt2 = wal.readUInt32BE(offset + 12);
    if (fSalt1 !== salt1 || fSalt2 !== salt2) break;
    [s1, s2] = walChecksum(wal, offset, 8, little, s1, s2);
    [s1, s2] = walChecksum(wal, offset + 24, pageSize, little, s1, s2);
    if (s1 !== wal.readUInt32BE(offset + 16) || s2 !== wal.readUInt32BE(offset + 20)) break;
    if (page === 0) break;
    frames.push({
      page,
      dbPages,
      data: wal.subarray(offset + 24, offset + 24 + pageSize),
    });
    offset += frameSize;
  }

  let lastCommit = -1;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].dbPages !== 0) lastCommit = i;
  }
  if (lastCommit < 0) return Buffer.from(main);

  const dbPages = frames[lastCommit].dbPages;
  const out = Buffer.alloc(Math.max(main.length, dbPages * pageSize));
  main.copy(out);
  for (let i = 0; i <= lastCommit; i++) {
    const frame = frames[i];
    frame.data.copy(out, (frame.page - 1) * pageSize);
  }
  if (out.length >= 32) {
    out.writeUInt32BE(dbPages, 28);
  }
  return out;
}

function materializeRollbackCopy(dbPath: string): string {
  const main = fs.readFileSync(dbPath);
  if (main.length < 100 || main.subarray(0, 15).toString("utf8") !== "SQLite format 3") {
    throw new Error("not a sqlite database");
  }
  let image: Buffer = Buffer.from(main);
  const walPath = dbPath + "-wal";
  if (fs.existsSync(walPath)) {
    image = Buffer.from(applyWal(main, fs.readFileSync(walPath)));
  }
  if (image.length >= 20) {
    image[18] = 1;
    image[19] = 1;
  }
  const dest = path.join(
    os.tmpdir(),
    `zcode-sqlite-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
  );
  fs.writeFileSync(dest, image, { mode: 0o600, flag: "wx" });
  return dest;
}

let nativeSqlite: boolean | undefined;
/** Whether this runtime provides the native SQLite module required by session storage. */
export function nativeSqliteAvailable(): boolean {
  if (nativeSqlite === undefined) {
    try {
      nativeSqlite = typeof require("node:sqlite").DatabaseSync === "function";
    } catch {
      nativeSqlite = false;
    }
  }
  return nativeSqlite;
}

/**
 * A rollback-journal snapshot also lets native SQLite read WAL stores that cannot initialize shared memory.
 * Building one copies the whole database (about a second for a 150 MB store), so keep the latest snapshot per
 * database and rebuild it only when the main file or its WAL changes size or modification time.
 */
const snapshots = new Map<string, { key: string; tempPath: string }>();
let exitCleanupRegistered = false;

function snapshotKey(dbPath: string): string {
  const stat = (file: string) => {
    try {
      const s = fs.statSync(file, { bigint: true });
      return `${s.size}:${s.mtimeNs}:${s.ino}`;
    } catch {
      return "-";
    }
  };
  return `${stat(dbPath)}|${stat(dbPath + "-wal")}`;
}

function dropSnapshot(dbPath: string): void {
  const cached = snapshots.get(dbPath);
  snapshots.delete(dbPath);
  if (!cached) return;
  try {
    fs.unlinkSync(cached.tempPath);
  } catch {
    /* ignore */
  }
}

function snapshotFor(dbPath: string): { tempPath: string; reused: boolean } {
  const key = snapshotKey(dbPath);
  const cached = snapshots.get(dbPath);
  if (cached?.key === key && fs.existsSync(cached.tempPath)) return { tempPath: cached.tempPath, reused: true };
  dropSnapshot(dbPath);
  const tempPath = materializeRollbackCopy(dbPath);
  snapshots.set(dbPath, { key, tempPath });
  // Snapshots hold a full copy of the user's chats; remove them even if deactivate never runs.
  if (!exitCleanupRegistered) {
    exitCleanupRegistered = true;
    process.once("exit", disposeSqliteSnapshots);
  }
  return { tempPath, reused: false };
}

const SNAPSHOT_NAME = /^zcode-sqlite-(\d+)-\d+-[0-9a-f]*\.sqlite(?:-journal|-wal|-shm)?$/;

/** kill(pid, 0) probes without signalling: ESRCH means gone, EPERM means alive under another user. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A crash or kill -9 skips both deactivate and the exit hook, leaving full chat copies in the temp directory.
 * On startup, delete snapshots whose owning process no longer exists. Only regular files we own that match our
 * own naming are touched; files of live processes (including a reused pid) are left alone.
 */
export async function cleanupOrphanedSqliteSnapshots(
  dir: string = os.tmpdir(),
  isAlive: (pid: number) => boolean = processAlive
): Promise<number> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  let removed = 0;
  for (const name of names) {
    const match = SNAPSHOT_NAME.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || isAlive(pid)) continue;
    const file = path.join(dir, name);
    try {
      const stat = await fs.promises.lstat(file);
      if (!stat.isFile() || (uid !== undefined && stat.uid !== uid)) continue;
      await fs.promises.unlink(file);
      removed++;
    } catch {
      /* raced with another window or already gone */
    }
  }
  if (removed) logDebug("Removed orphaned SQLite snapshots", removed);
  return removed;
}

/** Delete cached snapshots; registered for extension deactivation. */
export function disposeSqliteSnapshots(): void {
  for (const dbPath of [...snapshots.keys()]) dropSnapshot(dbPath);
}

function openSqlite(dbPath: string, writable = false): SqliteApi {
  try {
    return openNativeSqlite(dbPath, !writable);
  } catch (e) {
    const code = (e as { errcode?: number } | null)?.errcode;
    // CANTOPEN with a missing SHM, or READONLY_CANTINIT: the WAL is readable but its index cannot be built.
    // Do not bypass native locks or write to a copy instead of the real database.
    const needsSnapshot = code === 1288 ||
      (typeof code === "number" && (code & 0xff) === 14 && !fs.existsSync(dbPath + "-shm"));
    if (writable || !needsSnapshot || !fs.existsSync(dbPath + "-wal")) throw e;
    try {
      const snapshot = snapshotFor(dbPath);
      const db = openNativeSqlite(snapshot.tempPath, true);
      if (!snapshot.reused) logDebug("Opened native WAL snapshot for", dbPath);
      return db;
    } catch (snapErr) {
      dropSnapshot(dbPath);
      logWarn("Native SQLite could not read WAL snapshot", dbPath, e);
      throw snapErr;
    }
  }
}

function withWritableDb<T>(dbPath: string, fn: (db: SqliteApi) => T): T {
  return withDb(dbPath, fn, true);
}

function withDb<T>(dbPath: string, fn: (db: SqliteApi) => T, writable = false): T {
  const db = openSqlite(dbPath, writable);
  try {
    return fn(db);
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

function slugify(value: string): string {
  const text = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return text || "session";
}

/** Keep the desktop sidebar in sync. Chat bodies live in ~/.zcode/cli/db/db.sqlite. */
export function upsertDesktopTask(task: DesktopTask): boolean {
  const dbPath = tasksIndexPath();
  if (!fs.existsSync(dbPath)) return false;
  const now = Date.now();
  const title = task.title || "新会话";
  const model = task.model ?? null;
  const status = task.status ?? "completed";
  const savedSession = readSavedSession(task.sessionId);
  const updatedAt = task.updatedAt ?? now;
  const overridden = task.overrideTitle ? 1 : 0;
  try {
    withWritableDb(dbPath, (db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const scope = workspacePredicate(db, task.workspacePath);
        const rows = db.all(
          `SELECT workspace_key, workspace_path, created_at, mode, title, title_overridden, archived, deleted, pinned FROM tasks WHERE ${scope.sql} AND task_id=? ORDER BY updated_at DESC`,
          [...scope.values, task.sessionId]
        ) as Array<{ workspace_key: string; workspace_path?: string; created_at?: number; mode?: string; title: string; title_overridden: number; archived: number; deleted: number; pinned: number }>;
        const existing = rows[0];
        // Reuse the existing identity, including its Windows spelling. Creating an
        // alias row would collide with the desktop's UNIQUE(host_id, task_id).
        const workspaceKey = existing?.workspace_key || task.workspacePath;
        const workspacePath = existing?.workspace_path || workspaceKey;
        const createdAt = existing?.created_at || task.createdAt || savedSession?.time_created || now;
        const renamed = rows.find(row => row.title_overridden);
        const effectiveTitle = task.overrideTitle ? title : renamed?.title ?? title;
        const mode = task.mode || existing?.mode || "build";
        // `glm` is the desktop task-index agent id, not a model provider.
        const meta = JSON.stringify({
          taskId: task.sessionId,
          title: effectiveTitle,
          workspacePath,
          createdAt,
          updatedAt,
          mode,
          provider: "glm",
          status,
        });
        db.run(
          `
          INSERT INTO tasks (
            workspace_key, workspace_path, workspace_identity, task_id, title,
            task_status, provider, mode, model, created_at, updated_at,
            last_unread_at, pinned, archived, deleted, title_overridden,
            meta_json, searchable_text
          ) VALUES (?, ?, NULL, ?, ?, ?, 'glm', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, '')
          ON CONFLICT(workspace_key, task_id) DO UPDATE SET
            title=CASE
              WHEN excluded.title_overridden=1 THEN excluded.title
              WHEN tasks.title_overridden=1 THEN tasks.title
              ELSE excluded.title
            END,
            title_overridden=MAX(tasks.title_overridden, excluded.title_overridden),
            pinned=MAX(tasks.pinned, excluded.pinned),
            archived=MAX(tasks.archived, excluded.archived),
            deleted=MAX(tasks.deleted, excluded.deleted),
            provider=COALESCE(NULLIF(tasks.provider,''), excluded.provider),
            created_at=CASE WHEN COALESCE(tasks.created_at,0)=0 THEN excluded.created_at ELSE tasks.created_at END,
            task_status=excluded.task_status,
            mode=excluded.mode,
            model=COALESCE(excluded.model, tasks.model),
            updated_at=excluded.updated_at,
            meta_json=excluded.meta_json
          `,
          [
            workspaceKey,
            workspacePath,
            task.sessionId,
            effectiveTitle,
            status,
            mode,
            model,
            createdAt,
            updatedAt,
            Math.max(0, ...rows.map(row => row.pinned)),
            Math.max((savedSession && "time_archived" in savedSession
              ? savedSession.time_archived : task.archived) ? 1 : 0, ...rows.map(row => row.archived)),
            Math.max(0, ...rows.map(row => row.deleted)),
            overridden || (renamed ? 1 : 0),
            meta,
          ]
        );
        syncDesktopProject(db, workspacePath, task.sessionId, scope.values);
        if (task.overrideTitle) db.run(
          `UPDATE tasks SET title=?, title_overridden=1 WHERE ${scope.sql} AND task_id=?`,
          [title, ...scope.values, task.sessionId]
        );
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    });
    logDebug("Indexed session for desktop", task.sessionId);
    return true;
  } catch (e) {
    logWarn("Failed to index session for ZCode desktop", e);
    return false;
  }
}

/** Persisted archive timestamps take precedence over a server's cached session list. */
export function loadSessionArchiveTimes(sessionIds: string[]): Map<string, number | null> {
  const file = sessionDbPath();
  if (!sessionIds.length || !fs.existsSync(file)) return new Map();
  try {
    return withDb(file, db => {
      const rows = db.all(`SELECT id,time_archived FROM session WHERE id IN (${sessionIds.map(() => "?").join(",")})`, sessionIds) as
        Array<{ id: string; time_archived: number | null }>;
      return new Map(rows.map(row => [row.id, row.time_archived]));
    });
  } catch (e) {
    logWarn("Could not read saved session archive timestamps", e);
    return new Map();
  }
}

function readSavedSession(sessionId: string): { time_created?: number; time_archived?: number } | undefined {
  const file = sessionDbPath();
  if (!fs.existsSync(file)) return undefined;
  try {
    return withDb(file, db => db.get("SELECT * FROM session WHERE id=?", [sessionId]) ?? undefined) as
      { time_created?: number; time_archived?: number } | undefined;
  } catch (e) {
    logWarn("Could not read saved session facts for indexing", e);
    return undefined;
  }
}

/**
 * app-server only writes ~/.zcode/cli/db/db.sqlite on the first prompt.
 * Indexing the desktop sidebar before that leaves a ghost task that cannot
 * be resumed after the plugin process exits. Persist the session row now.
 */
export function persistCliSession(task: DesktopTask & { mode?: string }): boolean {
  const dbPath = sessionDbPath();
  if (!fs.existsSync(dbPath) || !task.sessionId || !task.workspacePath) return false;
  const now = task.updatedAt ?? Date.now();
  const placeholders = new Set(["", "新会话", "New session", "Untitled session"]);
  const title = (task.title || "").trim() || "Untitled session";
  const directory = task.workspacePath;
  const projectId = "proj_" + slugify(directory).slice(0, 80);
  const force = !!task.overrideTitle;
  const permission = JSON.stringify({ mode: task.mode || "build" });
  let skippedVersion = false;
  try {
    withWritableDb(dbPath, (db) => {
      const existing = db.get("select * from session where id=?", [
        task.sessionId,
      ]) as { title?: string; title_source?: string; version?: string; directory?: string } | null;
      if (existing) {
        let keepTitle = title;
        let source = existing.title_source || "first_input";
        if (force) {
          keepTitle = title;
          source = "custom";
        } else if (existing.title_source === "custom") {
          keepTitle = existing.title || title;
          source = "custom";
        } else if (placeholders.has(title) && existing.title && !placeholders.has(existing.title)) {
          keepTitle = existing.title;
        }
        const savedDirectory = existing.directory && sameWorkspacePath(existing.directory, directory) ? existing.directory : directory;
        db.run(
          `
          update session set title=?, title_source=?, directory=?, path=?, time_updated=?,
            time_title_updated=CASE WHEN ? THEN ? ELSE time_title_updated END
          where id=?
          `,
          [keepTitle, source, savedDirectory, savedDirectory, now, force ? 1 : 0, now, task.sessionId]
        );
        return;
      }
      const latest = db.get("select version from session order by time_updated desc limit 1") as
        | { version?: string }
        | null;
      const version = latest?.version?.trim() || "";
      if (!version) {
        skippedVersion = true;
        return;
      }
      db.run(
        `
        insert into session (
          id, project_id, workspace_id, parent_id, trace_id, task_type, slug,
          directory, path, title, title_source, title_message_id, version,
          share_url, summary_additions, summary_deletions, summary_files, summary_diffs,
          revert, permission, time_created, time_updated, time_title_updated,
          time_compacting, time_archived
        ) values (?, ?, NULL, NULL, NULL, 'interactive', ?, ?, ?, ?, 'first_input', NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, NULL)
        `,
        [
          task.sessionId,
          projectId,
          slugify(task.sessionId),
          directory,
          directory,
          title,
          version,
          permission,
          now,
          now,
        ]
      );
    });
    if (skippedVersion) {
      logWarn("CLI session table has no version yet; skipped session row", task.sessionId);
      return false;
    } else {
      logDebug("Persisted session to CLI db", task.sessionId);
    }
    return true;
  } catch (e) {
    logWarn("Failed to persist session to CLI db", e);
    return false;
  }
}

export function setTaskArchived(
  workspacePath: string,
  sessionId: string,
  archived: boolean
): void {
  const now = Date.now();
  let indexSaved = false;
  const indexPath = tasksIndexPath();
  if (fs.existsSync(indexPath)) {
    try {
      withWritableDb(indexPath, (db) => {
        const scope = workspacePredicate(db, workspacePath);
        const result = db.run(
          `UPDATE tasks SET archived=?, updated_at=? WHERE ${scope.sql} AND task_id=?`,
          [archived ? 1 : 0, now, ...scope.values, sessionId]
        );
        indexSaved = Number((result as { changes: number | bigint }).changes) > 0;
      });
    } catch (e) {
      logWarn("Failed to update desktop archive flag", e);
      throw e;
    }
  }

  const cliPath = sessionDbPath();
  if (fs.existsSync(cliPath)) {
    try {
      withWritableDb(cliPath, (db) => {
        db.run("UPDATE session SET time_archived=?, time_updated=? WHERE id=?", [
          archived ? now : null,
          now,
          sessionId,
        ]);
      });
    } catch (e) {
      logWarn("Failed to update session archive timestamp", e);
      if (indexSaved) throw new SessionSyncError("会话归档状态已保存到桌面索引，但会话数据库同步失败。请重试相同操作。", {}, { cause: e });
      throw e;
    }
  }
}

export function loadOverriddenTitles(workspacePath: string): Record<string, string> {
  const indexPath = tasksIndexPath();
  if (!fs.existsSync(indexPath) || !workspacePath) return {};
  try {
    return withDb(indexPath, (db) => {
      const scope = workspacePredicate(db, workspacePath);
      const rows = db.all(
        `SELECT task_id, title FROM tasks WHERE ${scope.sql} AND title_overridden=1 AND deleted=0 AND trim(title)!='' ORDER BY updated_at ASC`,
        scope.values
      ) as Array<{ task_id: string; title: string }>;
      const out: Record<string, string> = {};
      for (const row of rows) out[row.task_id] = row.title;
      return out;
    });
  } catch (e) {
    logWarn("Failed to read overridden session titles", e);
    return {};
  }
}

export function setSessionDisplayTitle(
  workspacePath: string,
  sessionId: string,
  title: string
): void {
  const next = title.trim();
  if (!next || !sessionId) return;
  const now = Date.now();
  const persisted = persistCliSession({
    workspacePath,
    sessionId,
    title: next,
    updatedAt: now,
    overrideTitle: true,
  });
  if (!persisted) throw new LocalizedError("会话名称未能保存到会话数据库，请查看日志。");
  const indexed = upsertDesktopTask({
    workspacePath,
    sessionId,
    title: next,
    updatedAt: now,
    overrideTitle: true,
  });
  if (!indexed) throw new SessionSyncError("会话名称已保存，但桌面索引同步失败。请重试重命名。");
}

export function setTaskDeleted(workspacePath: string, sessionId: string): void {
  const now = Date.now();
  const indexPath = tasksIndexPath();
  if (!fs.existsSync(indexPath)) throw new LocalizedError("桌面会话索引不存在，无法删除会话。");
  if (fs.existsSync(indexPath)) {
    try {
      withWritableDb(indexPath, (db) => {
        const scope = workspacePredicate(db, workspacePath);
        db.run(
          `UPDATE tasks SET deleted=1, archived=0, updated_at=? WHERE ${scope.sql} AND task_id=?`,
          [now, ...scope.values, sessionId]
        );
      });
    } catch (e) {
      logWarn("Failed to mark desktop task deleted", e);
      throw e;
    }
  }
}

export function loadTaskFlags(workspacePath: string): {
  archived: string[];
  deleted: string[];
} {
  const indexPath = tasksIndexPath();
  if (!fs.existsSync(indexPath)) return { archived: [], deleted: [] };
  try {
    return withDb(indexPath, (db) => {
      const scope = workspacePredicate(db, workspacePath);
      const archived = (
        db.all(
          `SELECT DISTINCT task_id FROM tasks WHERE ${scope.sql} AND archived=1 AND deleted=0`,
          scope.values
        ) as Array<{ task_id: string }>
      ).map((r) => r.task_id);
      const deleted = (
        db.all(
          `SELECT DISTINCT task_id FROM tasks WHERE ${scope.sql} AND deleted=1`,
          scope.values
        ) as Array<{ task_id: string }>
      ).map((r) => r.task_id);
      return { archived, deleted };
    });
  } catch (e) {
    logWarn("Failed to read archive flags", e);
    return { archived: [], deleted: [] };
  }
}
