import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, execFileSync } from 'child_process';
import { performance } from 'perf_hooks';
import * as vscode from 'vscode';
import { loadTaskFlags, loadOverriddenTitles, listSessionQuestions, sessionsFinishedSince, setTaskArchived, setTaskDeleted, upsertDesktopTask, setSessionDisplayTitle, disposeSqliteSnapshots } from '../taskIndex';
const loader = require('module');
const originalLoad = loader._load;
const originalResolve = loader._resolveFilename;
const originalWrite = fs.writeFileSync;
const writableFs = require('fs');
const { DatabaseSync } = originalLoad('node:sqlite', module, false);
const runRoot = process.env.SQLITE_HOST_RUN!;
const originalHome = os.homedir;
const originalTmp = os.tmpdir;
const reportPath = process.env.SQLITE_HOST_REPORT!;
const writableOs = require('os');
interface Hooks {
    nativeOpens: number;
    wasmOpens: number;
    nativeErrors: any[];
    nativeFiles: Array<{
        file: string;
        options?: {
            readOnly?: boolean;
        };
    }>;
    snapshots: string[];
}
let hooks: Hooks = { nativeOpens: 0, wasmOpens: 0, nativeErrors: [], nativeFiles: [], snapshots: [] };
const trace: any[] = [];
(globalThis as any).__sqliteTrace = trace;
const schema = `CREATE TABLE tasks(workspace_key TEXT,workspace_path TEXT,workspace_identity TEXT,task_id TEXT,title TEXT,task_status TEXT,provider TEXT,mode TEXT,model TEXT,created_at INTEGER,updated_at INTEGER,last_unread_at INTEGER,pinned INTEGER DEFAULT 0,archived INTEGER DEFAULT 0,deleted INTEGER DEFAULT 0,title_overridden INTEGER DEFAULT 0,meta_json TEXT,searchable_text TEXT,PRIMARY KEY(workspace_key,task_id));`;
const cliSchema = `CREATE TABLE session(id TEXT PRIMARY KEY,project_id TEXT,workspace_id TEXT,parent_id TEXT,trace_id TEXT,task_type TEXT,slug TEXT,directory TEXT,path TEXT,title TEXT,title_source TEXT,title_message_id TEXT,version TEXT,share_url TEXT,summary_additions INTEGER,summary_deletions INTEGER,summary_files INTEGER,summary_diffs TEXT,revert TEXT,permission TEXT,time_created INTEGER,time_updated INTEGER,time_title_updated INTEGER,time_compacting INTEGER,time_archived INTEGER);
CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,sequence INTEGER,data TEXT);
CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,sequence INTEGER,data TEXT);
CREATE TABLE turn_usage(session_id TEXT,started_at INTEGER,completed_at INTEGER);`;
function equal(a: any, b: any) { return JSON.stringify(a) === JSON.stringify(b); }
function base(root: string) {
    const indexPath = path.join(root, '.zcode/v2/tasks-index.sqlite'), cliPath = path.join(root, '.zcode/cli/db/db.sqlite');
    for (const file of [indexPath, cliPath])
        fs.mkdirSync(path.dirname(file), { recursive: true });
    const i = new DatabaseSync(indexPath);
    i.exec(schema);
    for (const [id, archived, deleted, overridden] of [['s1', 0, 0, 1], ['archived', 1, 0, 0], ['deleted', 0, 1, 0]])
        i.prepare("INSERT INTO tasks(workspace_key,task_id,title,archived,deleted,title_overridden,updated_at) VALUES('/fixture',?,?,?,?,?,1)").run(id, id === 's1' ? 'Saved' : id, archived, deleted, overridden);
    i.close();
    const c = new DatabaseSync(cliPath);
    c.exec(cliSchema);
    c.exec("INSERT INTO session(id,directory,path,title,title_source,version,time_updated) VALUES('s1','/fixture','/fixture','Saved','custom','3.16.2',1)");
    c.exec(`INSERT INTO message VALUES('m1','s1',1700000000,1,'{"role":"user"}'),('m2','s1',1700000001,2,'{"role":"assistant"}');
 INSERT INTO part VALUES('p2','m1',2,'{"type":"text","text":"question"}'),('p1','m1',1,'{"type":"text","text":"first "}'),('p3','m1',3,'{"type":"text","text":"ignored","synthetic":true}'),('p4','m2',1,'{"type":"text","text":"ignored"}');
 INSERT INTO turn_usage VALUES('s1',1700000000000,1700000005000);`);
    c.exec('CREATE TABLE padding(data BLOB);BEGIN');
    const insert = c.prepare('INSERT INTO padding VALUES(zeroblob(65536))');
    for (let x = 0; x < 16; x++)
        insert.run();
    c.exec('COMMIT');
    c.close();
    return { indexPath, cliPath };
}
async function writer(files: {
    indexPath: string;
    cliPath: string;
}, journal = 'WAL') {
    const child = spawn(process.env.SQLITE_WRITER_NODE!, [path.join(__dirname, 'writer.cjs'), files.indexPath, files.cliPath, journal], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    });
    let errors = '';
    child.stderr!.on('data', d => errors += d);
    const message = () => new Promise<any>((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timer);
            child.off('message', received);
            child.off('error', failed);
            child.off('exit', exited);
        };
        const received = (value: unknown) => { cleanup(); resolve(value); };
        const failed = (error: Error) => { cleanup(); reject(error); };
        const exited = () => failed(new Error('writer exited before replying: ' + errors));
        const timer = setTimeout(() => failed(new Error('writer timeout: ' + errors)), 10000);
        child.once('message', received);
        child.once('error', failed);
        child.once('exit', exited);
    });
    try {
        const ready = await message();
        if (!ready.ready) throw new Error('writer not ready');
    } catch (e) {
        child.kill('SIGKILL');
        throw e;
    }
    return {
        async send(command: string) {
            const response = message();
            child.send(command);
            const reply = await response;
            if (reply.error) throw new Error(reply.error);
        },
        async kill() {
            if (child.exitCode !== null || child.signalCode !== null) return;
            const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
            child.kill('SIGKILL');
            await exited;
        },
    };
}
function installHooks(mode: string) {
    hooks = { nativeOpens: 0, wasmOpens: 0, nativeErrors: [], nativeFiles: [], snapshots: [] };
    const forbidWasm = (name: string) => { if (name.includes('node-sqlite3-wasm')) {
        hooks.wasmOpens++;
        throw new Error('test forbids any WASM access in the native snapshot backend');
    } };
    loader._resolveFilename = function (name: string, ...args: any[]) { forbidWasm(name); return originalResolve.call(this, name, ...args); };
    loader._load = function (name: string, ...args: any[]) {
        forbidWasm(name);
        if (name === 'node:sqlite') {
            if (mode === 'native-unavailable')
                throw new Error('test forces missing node:sqlite');
            const actual = originalLoad.call(this, name, ...args);
            return { ...actual, DatabaseSync: new Proxy(actual.DatabaseSync, { construct(C: any, args: any[]) {
                        hooks.nativeOpens++;
                        hooks.nativeFiles.push({ file: args[0], options: args[1] });
                        const record = (e: any) => hooks.nativeErrors.push({ message: e.message, code: e.code, errcode: e.errcode, errstr: e.errstr });
                        try {
                        const db: any = Reflect.construct(C, mode === 'exclusive-lock'
                            ? [args[0], { ...args[1], timeout: 50 }] : args);
                        if (mode === 'exclusive-lock') {
                            // Test actual SQLITE_BUSY without blocking the GUI host for its five-second production timeout.
                            const exec = db.exec.bind(db);
                            db.exec = (sql: string) => exec(sql.replace(/busy_timeout\s*=\s*5000/gi, 'busy_timeout=50'));
                        }
                            const prepare = db.prepare;
                            db.prepare = function (...params: any[]) {
                                try {
                                    const stmt = prepare.apply(db, params);
                                    for (const method of ['get', 'all', 'run']) {
                                        const original = stmt[method];
                                        stmt[method] = function (...values: any[]) { try {
                                            return original.apply(stmt, values);
                                        }
                                        catch (e) {
                                            record(e);
                                            throw e;
                                        } };
                                    }
                                    return stmt;
                                }
                                catch (e) {
                                    record(e);
                                    throw e;
                                }
                            };
                            return db;
                        }
                        catch (e: any) {
                            record(e);
                            throw e;
                        }
                    } }) };
        }
        return originalLoad.call(this, name, ...args);
    };
    writableFs.writeFileSync = function (file: any, ...args: any[]) {
        if (typeof file === 'string' && /zcode-sqlite-\d+-/.test(path.basename(file)))
            hooks.snapshots.push(file);
        return (originalWrite as (...values: any[]) => void).call(this, file, ...args);
    };
}
function restoreHooks() { loader._load = originalLoad; loader._resolveFilename = originalResolve; writableFs.writeFileSync = originalWrite; }
function check(row: any, condition: unknown, label: string) { row.assertions.push({ label, pass: !!condition }); }
const sid = process.platform === "win32"
    ? execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).match(/S-\d-(?:\d+-)*\d+/)?.[0]
    : undefined;
function permissions(files: {
    indexPath: string;
    cliPath: string;
}, readonly: boolean) {
    for (const dir of [path.dirname(files.indexPath), path.dirname(files.cliPath)]) {
        if (process.platform === "win32") {
            if (!sid)
                throw new Error("Could not determine the test user's Windows SID");
            // Generic W also denies SYNCHRONIZE, which read handles need. Deny only specific write rights.
            const args = readonly ? [dir, "/deny", `*${sid}:(OI)(CI)(WD,AD,WEA,WA)`] : [dir, "/remove:d", `*${sid}`, "/T", "/C"];
            execFileSync("icacls", args, { stdio: "pipe" });
        }
        else {
            if (!readonly)
                fs.chmodSync(dir, 0o700);
            for (const file of fs.readdirSync(dir).map(n => path.join(dir, n)))
                fs.chmodSync(file, readonly ? 0o400 : 0o600);
            if (readonly)
                fs.chmodSync(dir, 0o500);
        }
        if (readonly) {
            for (const file of fs.readdirSync(dir).map(name => path.join(dir, name))) {
                const handle = fs.openSync(file, "r");
                fs.closeSync(handle);
            }
            // Prove the fixture is actually read-only; Windows chmod and POSIX tests run as root cannot establish this.
            const probe = path.join(dir, "permission-probe");
            let denied = false;
            try {
                fs.writeFileSync(probe, "must fail");
            }
            catch (e) {
                denied = ["EACCES", "EPERM", "EROFS"].includes((e as NodeJS.ErrnoException).code || "");
            }
            if (!denied) {
                fs.rmSync(probe, { force: true });
                throw new Error("Test directory is not read-only: " + dir);
            }
        }
    }
}
function fingerprints(files: any) {
    const crypto = require('node:crypto');
    return [files.indexPath, files.indexPath + '-wal', files.cliPath, files.cliPath + '-wal'].map(file => fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null);
}
function readExpected(wal: boolean, second = false) {
    const questions: any[] = [{ id: 'm1', text: 'first question', at: 1700000000000 }];
    const archived = ['archived'];
    if (wal) {
        questions.push({ id: 'wal-committed', text: 'wal-committed', at: 1700000010000 });
        archived.push('wal-committed');
    }
    if (second) {
        questions.push({ id: 'wal-second', text: 'wal-second', at: 1700000011000 });
        archived.push('wal-second');
    }
    return { flags: { archived, deleted: ['deleted'] }, questions, titles: { s1: 'Saved' }, finished: ['s1'] };
}
function readAll() { return { flags: loadTaskFlags('/fixture'), questions: listSessionQuestions('s1'), titles: loadOverriddenTitles('/fixture'), finished: sessionsFinishedSince([{ sessionId: 's1', since: 1700000004000 }]) }; }
function writable(files: any) {
    setTaskArchived('/fixture', 's1', true);
    setTaskArchived('/fixture', 's1', false);
    setSessionDisplayTitle('/fixture', 's1', 'Renamed');
    if (!upsertDesktopTask({ workspacePath: '/fixture', sessionId: 'new-session', title: 'New session' }))
        throw new Error('upsert rejected');
    setTaskDeleted('/fixture', 's1');
    const index = new DatabaseSync(files.indexPath), cli = new DatabaseSync(files.cliPath);
    try {
        const row = index.prepare("SELECT deleted,archived,title FROM tasks WHERE task_id='s1'").get();
        const session = cli.prepare("SELECT title,time_archived FROM session WHERE id='s1'").get();
        const created = index.prepare("SELECT count(*) AS n FROM tasks WHERE task_id='new-session'").get();
        if (!(row.deleted === 1 && row.archived === 0 && row.title === 'Renamed' && session.title === 'Renamed' && session.time_archived === null && created.n === 1))
            throw new Error('write persistence mismatch');
    }
    finally {
        index.close();
        cli.close();
    }
}
export async function run() {
    writableOs.tmpdir = () => path.join(runRoot, 'temp');
    const results: any = { sourceSha: process.env.SQLITE_SOURCE_SHA, backend: 'native-production', runtime: { vscode: vscode.version, node: process.versions.node, electron: process.versions.electron, sqlite: process.versions.sqlite, platform: process.platform, arch: process.arch, kind: 'VS Code extension host' }, rows: [] };
    let failed = false;
    try {
        for (const name of ['rollback', 'active-wal', 'crash-wal', 'wal-no-shm', 'readonly-wal', 'readonly-no-shm', 'readonly-rollback', 'exclusive-lock', 'corrupt', 'native-unavailable']) {
            const root = path.join(runRoot, 'fixtures', name);
            const files = base(root);
            let processWriter: Awaited<ReturnType<typeof writer>> | undefined;
            const row: any = { scenario: name, assertions: [] };
            if (name === 'exclusive-lock') row.lockTimeoutMs = 50;
            const wal = ['active-wal', 'crash-wal', 'wal-no-shm', 'readonly-wal', 'readonly-no-shm'].includes(name);
            try {
                if (wal) {
                    processWriter = await writer(files);
                    await processWriter.send('hold');
                    if (name !== 'active-wal') {
                        await processWriter.kill();
                        processWriter = undefined;
                        if (['wal-no-shm', 'readonly-no-shm'].includes(name))
                            for (const file of [files.indexPath, files.cliPath])
                                fs.rmSync(file + '-shm', { force: true });
                    }
                }
                if (name === 'exclusive-lock') {
                    processWriter = await writer(files, 'DELETE');
                    await processWriter.send('exclusive');
                }
                if (name.startsWith('readonly'))
                    permissions(files, true);
                if (name === 'corrupt')
                    for (const file of [files.indexPath, files.cliPath])
                        fs.writeFileSync(file, 'not a sqlite database');
                writableOs.homedir = () => root;
                trace.length = 0;
                installHooks(name);
                const before = performance.now();
                const actual = name === 'exclusive-lock' ? { flags: loadTaskFlags('/fixture') } : readAll();
                row.readMs = Number((performance.now() - before).toFixed(2));
                row.actual = actual;
                const negative = ['exclusive-lock', 'corrupt', 'native-unavailable'].includes(name);
                if (negative) {
                    check(row, equal(actual.flags, { archived: [], deleted: [] }), name + ' returns no accepted data');
                    check(row, hooks.snapshots.length === 0, name + ' does not bypass via snapshot');
                    check(row, trace.some(item => item[0] === 'warn'), name + ' logs failure');
                }
                else {
                    check(row, equal(actual, readExpected(wal)), 'all real business queries match expected including WAL');
                    check(row, !JSON.stringify(actual).includes('uncommitted'), 'uncommitted content invisible');
                    const snapshotCount = hooks.snapshots.length;
                    check(row, equal(readAll(), readExpected(wal)), 'repeat read remains complete');
                    check(row, hooks.snapshots.length === snapshotCount, 'repeat read reuses snapshot cache');
                    if (name === 'readonly-no-shm') {
                        check(row, snapshotCount === 2, 'one native snapshot each for index and CLI');
                        const snapOpens = hooks.nativeFiles.filter((item: any) => hooks.snapshots.includes(item.file));
                        check(row, snapOpens.length > 0 && snapOpens.every((item: any) => item.options?.readOnly === true), 'all snapshots opened native readOnly');
                        const preserved = fingerprints(files);
                        let rejected = false;
                        try {
                            setTaskArchived('/fixture', 's1', true);
                        }
                        catch {
                            rejected = true;
                        }
                        check(row, rejected, 'read-only WAL write throws');
                        check(row, !upsertDesktopTask({ workspacePath: '/fixture', sessionId: 'forbidden', title: 'Must not persist' }), 'upsert honestly rejects read-only WAL');
                        check(row, equal(fingerprints(files), preserved), 'rejected writes do not alter source DB or WAL');
                        check(row, hooks.snapshots.length === snapshotCount, 'writes never fall back to snapshot');
                        // Prepare a newer valid committed DB+WAL in a different writable directory, then replace the read-only source.
                        const alternate = base(path.join(runRoot, 'replacement'));
                        const alternateWriter = await writer(alternate);
                        await alternateWriter.send('commit');
                        await alternateWriter.kill();
                        permissions(files, false);
                        for (const key of ['indexPath', 'cliPath'] as const) {
                            fs.copyFileSync(alternate[key], files[key]);
                            fs.copyFileSync(alternate[key] + '-wal', files[key] + '-wal');
                            fs.rmSync(files[key] + '-shm', { force: true });
                        }
                        permissions(files, true);
                        const oldSnapshots = [...hooks.snapshots];
                        check(row, equal(readAll(), readExpected(true, true)), 'read-only WAL cache invalidates on new committed source');
                        check(row, hooks.snapshots.length === snapshotCount + 2, 'new source builds precisely two replacement snapshots');
                        check(row, oldSnapshots.every(file => !fs.existsSync(file)), 'replaced snapshots removed');
                    }
                    else
                        check(row, snapshotCount === 0, 'ordinary case uses native original without snapshot');
                    if (name === 'active-wal') {
                        await processWriter!.send('commit');
                        check(row, equal(readAll(), readExpected(true, true)), 'new committed rows immediately visible');
                    }
                    if (['rollback', 'crash-wal', 'wal-no-shm'].includes(name)) {
                        writable(files);
                        check(row, true, 'archive/unarchive/rename/delete/upsert persist in original');
                    }
                    if (['readonly-wal', 'readonly-rollback'].includes(name)) {
                        const preserved = fingerprints(files);
                        let rejected = false;
                        try {
                            setTaskArchived('/fixture', 's1', true);
                        }
                        catch {
                            rejected = true;
                        }
                        check(row, rejected, 'read-only source rejects write');
                        check(row, equal(fingerprints(files), preserved), 'rejected write preserves DB and WAL');
                    }
                }
                check(row, hooks.wasmOpens === 0, 'zero WASM load or resolve attempts');
                row.nativeFiles = hooks.nativeFiles;
                row.nativeErrors = hooks.nativeErrors;
                row.snapshots = hooks.snapshots;
                row.wasmAttempts = hooks.wasmOpens;
                row.logs = trace.map(item => item.map((v: any) => v instanceof Error ? { name: v.name, message: v.message, code: Reflect.get(v, "code"), errcode: Reflect.get(v, "errcode") } : v));
            }
            catch (e: any) {
                row.error = e.stack ?? e.message;
                failed = true;
            }
            finally {
                const snapshotPaths = [...hooks.snapshots];
                restoreHooks();
                writableOs.homedir = originalHome;
                disposeSqliteSnapshots();
                check(row, snapshotPaths.every(file => !fs.existsSync(file)), 'dispose removes all produced snapshots');
                if (name.startsWith('readonly'))
                    permissions(files, false);
                if (processWriter) {
                    try {
                        await processWriter.kill();
                    }
                    catch { }
                }
            }
            if (row.assertions.some((item: any) => !item.pass))
                failed = true;
            row.passed = !row.error && row.assertions.every((item: any) => item.pass);
            results.rows.push(row);
            fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
        }
    }
    finally {
        restoreHooks();
        writableOs.homedir = originalHome;
        disposeSqliteSnapshots();
        writableOs.tmpdir = originalTmp;
    }
    results.passed = !failed;
    results.assertions = results.rows.flatMap((row: any) => row.assertions).length;
    fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
    console.log('SQLITE_HOST_RESULT ' + JSON.stringify({ runtime: results.runtime, rows: results.rows.length, assertions: results.assertions, passed: results.passed }));
    if (failed)
        throw new Error('SQLite production regression failed; see ' + reportPath);
}
