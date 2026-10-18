import assert from "node:assert/strict";
import test from "node:test";
import {
  applyConversationFrame,
  buildConversationView,
  createWireDecoder,
  materializeGitDiff,
  readGitFiles,
  slimRow,
} from "./conversation";

test("snapshot keeps the editable user row and the turn file summary", () => {
  const applied = applyConversationFrame([], {
    payload: {
      kind: "snapshot",
      snapshot: {
        logEpoch: "epoch-1",
        revision: 4,
        rows: {
          window: [
            {
              rowId: 1,
              kind: "turnHeader",
              turnId: "t1",
              entityId: "h1",
              fileChanges: { files: 1, additions: 3, deletions: 1, state: "active" },
              actions: { canRewindFiles: true },
            },
            {
              rowId: 2,
              kind: "userInput",
              turnId: "t1",
              entityId: "u1",
              origin: "realUser",
              text: "fix the bug",
              actions: { canEdit: true, editDisposition: "rewind" },
            },
            {
              rowId: 3,
              kind: "assistantText",
              turnId: "t1",
              text: "assistant body retained for rendering",
            },
          ],
        },
      },
    },
  });
  assert.equal(applied.logEpoch, "epoch-1");
  assert.equal(applied.revision, 4);
  assert.equal(applied.rows[2].text, "assistant body retained for rendering");
  const view = buildConversationView(applied.rows);
  assert.deepEqual(view.editable, {
    target: { rowId: 2, entityId: "u1" },
    text: "fix the bug",
  });
  assert.equal(view.turns.length, 1);
  assert.equal(view.turns[0].fileChanges?.summary.files, 1);
  assert.equal(view.turns[0].fileChanges?.canRewind, true);
});

test("removed rows drop the tail and clear edit on older user rows", () => {
  const first = applyConversationFrame([], {
    payload: {
      kind: "snapshot",
      snapshot: {
        rows: {
          window: [
            {
              rowId: 2,
              kind: "userInput",
              turnId: "t1",
              entityId: "u1",
              origin: "realUser",
              text: "first",
            },
            {
              rowId: 8,
              kind: "userInput",
              turnId: "t2",
              entityId: "u2",
              origin: "realUser",
              text: "second",
              actions: { canEdit: true },
            },
          ],
        },
      },
    },
  });
  const cut = applyConversationFrame(first.rows, {
    payload: { kind: "deltas", deltas: [{ op: "row.removed", fromRowId: 8 }] },
  });
  assert.equal(cut.rows.length, 1);
  assert.equal(buildConversationView(cut.rows).editable, null);
});

test("a late appended row lands in rowId order and an unsorted snapshot is normalized", () => {
  const base = applyConversationFrame([], {
    payload: { kind: "snapshot", snapshot: { logEpoch: "epoch", rows: { window: [
      { rowId: 2, kind: "userInput", turnId: "t1", entityId: "u1", origin: "realUser", text: "first" },
      { rowId: 4, kind: "assistantText", turnId: "t1", text: "reply" },
    ] } } },
  });
  // The next turn's rows append first; the previous turn's model-change row
  // (a smaller rowId) arrives afterwards and must not land after them.
  const appended = applyConversationFrame(base.rows, {
    payload: { kind: "deltas", deltas: [
      { op: "row.appended", row: { rowId: 8, kind: "userInput", turnId: "t2", entityId: "u2", origin: "realUser", text: "second" } },
    ] },
  });
  const late = applyConversationFrame(appended.rows, {
    payload: { kind: "deltas", deltas: [
      { op: "row.appended", row: { rowId: 6, kind: "assistantText", turnId: "t1", text: "late settle" } },
    ] },
  });
  assert.deepEqual(late.rows.map(row => row.rowId), [2, 4, 6, 8]);
  // The out-of-order tail must not render after the newer question.
  const view = buildConversationView(late.rows);
  assert.deepEqual(view.turns.map(turn => turn.userText), ["first", "second"]);
  // A snapshot whose window arrives unordered is normalized the same way.
  const snapshot = applyConversationFrame([], {
    payload: { kind: "snapshot", snapshot: { logEpoch: "epoch", rows: { window: [
      { rowId: 9, kind: "userInput", turnId: "t2", entityId: "u3", origin: "realUser", text: "next" },
      { rowId: 3, kind: "userInput", turnId: "t1", entityId: "u1", origin: "realUser", text: "old" },
    ] } } },
  });
  assert.deepEqual(snapshot.rows.map(row => row.rowId), [3, 9]);
});

test("timeline rows keep model switches and drop unrelated markers", () => {
  const changed = slimRow({
    rowId: 6,
    kind: "timelineMarker",
    marker: {
      type: "modelChange",
      fromProvider: "deepseek",
      fromModel: "deepseek-flash",
      toProvider: "example",
      toModel: "GLM-5.3-Flash",
      toThought: "max",
    },
  });
  assert.deepEqual(changed?.marker, {
    type: "modelChange",
    fromProvider: "deepseek",
    fromModel: "deepseek-flash",
    toProvider: "example",
    toModel: "GLM-5.3-Flash",
  });
  const initial = slimRow({
    rowId: 1,
    kind: "timelineMarker",
    marker: { type: "modelChange", toProvider: "example", toModel: "GLM-5.3", toThought: "max" },
  });
  assert.deepEqual(initial?.marker, { type: "modelChange", toProvider: "example", toModel: "GLM-5.3" });
  assert.equal(slimRow({
    rowId: 2,
    kind: "timelineMarker",
    marker: { type: "forkNotice", parentSessionId: "parent", parentRowId: 1 },
  })?.marker, undefined);
});

test("reverse apply rebuilds the previous file and falls back when the disk changed", () => {
  const patches = [
    {
      oldStart: 2,
      oldLines: 1,
      newStart: 2,
      newLines: 1,
      lines: ["-b", "+B"],
    },
  ];
  const matched = materializeGitDiff("a\nB\nc", patches);
  assert.equal(matched.before, "a\nb\nc");
  assert.equal(matched.after, "a\nB\nc");
  const fallback = materializeGitDiff("completely different", patches);
  assert.equal(fallback.before, "b");
  assert.equal(fallback.after, "B");
  const created = materializeGitDiff("hello\n", [
    { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+hello"] },
  ]);
  assert.equal(created.before, "");
  assert.equal(created.after, "hello\n");
});

test("file change query items keep structured patches", () => {
  const files = readGitFiles({
    files: 1,
    additions: 1,
    deletions: 0,
    items: [
      {
        path: "src/a.ts",
        additions: 1,
        deletions: 0,
        writeCount: 1,
        toolNames: ["edit"],
        patches: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ["+export {}"] }],
      },
    ],
  });
  assert.equal(files[0].path, "src/a.ts");
  assert.deepEqual(files[0].patches[0].lines, ["+export {}"]);
});

test("wire envelopes unwrap a complete frame and reassemble fragments", () => {
  const logical = {
    topic: "conversation/sess",
    payload: {
      kind: "snapshot",
      snapshot: {
        logEpoch: "epoch-wire",
        revision: 9,
        rows: {
          window: [
            {
              rowId: 4,
              kind: "userInput",
              turnId: "t",
              entityId: "u",
              origin: "realUser",
              text: "hello",
              actions: { canEdit: true },
            },
          ],
        },
      },
    },
  };
  const wrapped = createWireDecoder().push({ kind: "complete", frame: logical });
  const fromComplete = applyConversationFrame([], wrapped);
  assert.equal(fromComplete.logEpoch, "epoch-wire");
  assert.equal(buildConversationView(fromComplete.rows).editable?.text, "hello");

  const bytes = new TextEncoder().encode(JSON.stringify(logical));
  const mid = Math.max(1, Math.floor(bytes.length / 2));
  const head = Buffer.from(bytes.subarray(0, mid)).toString("base64");
  const tail = Buffer.from(bytes.subarray(mid)).toString("base64");
  const decoder = createWireDecoder();
  assert.equal(
    decoder.push({
      kind: "fragment",
      logicalFrameId: "frame-1",
      fragmentIndex: 1,
      fragmentCount: 2,
      dataBase64: tail,
    }),
    null
  );
  const frame = decoder.push({
    kind: "fragment",
    logicalFrameId: "frame-1",
    fragmentIndex: 0,
    fragmentCount: 2,
    dataBase64: head,
  });
  const fromParts = applyConversationFrame([], frame);
  assert.equal(fromParts.revision, 9);
  assert.equal(fromParts.rows.length, 1);
});

import { ConversationReplica } from "./conversation";

const topic = "conversation/A";
const snapshot = (seq: number, text: string, subscriptionId = "new", logEpoch = "epoch") => ({
  topic, subscriptionId, fromSeq: 0, toSeq: seq,
  payload: { kind: "snapshot", snapshot: { logEpoch, seq, rows: { window: [
    { rowId: 2, kind: "reasoning", text, state: "streaming" },
  ] } } },
});
const delta = (fromSeq: number, toSeq: number, append: string, subscriptionId = "new") => ({
  topic, subscriptionId, fromSeq, toSeq,
  payload: { kind: "deltas", deltas: [{ op: "row.delta", rowId: 2, path: "text", append }] },
});

test("atomic sequence batches retain repeated characters, but reject repeated frames", () => {
  const replica = new ConversationReplica(topic, "new");
  replica.receive(snapshot(5, "哈"));
  const frame = delta(5, 8, "哈abcabc\n\n");
  assert.equal(replica.receive(frame), "applied");
  assert.equal(replica.receive(frame), "ignored");
  assert.equal(replica.rows[0].text, "哈哈abcabc\n\n");
});

test("partially overlapping and missing batches require a snapshot without committing any text", () => {
  for (const from of [4, 6]) {
    const replica = new ConversationReplica(topic, "new");
    replica.receive(snapshot(5, "正确前缀。"));
    assert.equal(replica.receive(delta(from, 9, "重复或漏字。")), "resync");
    assert.equal(replica.rows[0].text, "正确前缀。");
    assert.equal(replica.receive(delta(5, 10, "不能猜测恢复。")), "resync");
    assert.equal(replica.receive(snapshot(10, "完整的正确内容。")), "applied");
    replica.receive(delta(10, 11, "继续。"));
    assert.equal(replica.rows[0].text, "完整的正确内容。继续。");
  }
});

test("old subscription frames cannot modify a newly selected conversation", () => {
  const replica = new ConversationReplica(topic, "new");
  assert.equal(replica.receive(snapshot(100, "旧会话", "old")), "ignored");
  replica.receive(snapshot(5, "新订阅"));
  assert.equal(replica.receive(delta(5, 6, "旧尾巴", "old")), "ignored");
  assert.equal(replica.rows[0].text, "新订阅");
});

test("canonical snapshot removes the user's exact short duplication, including a shorter correction", () => {
  const correct = "已完成的段用持久化文本**整体替换**实时缓冲并打上 complete 标记，迟到的重放直接被拒";
  const polluted = correct.replace("迟到", "迟文本**整体替换**实时缓冲并打上 complete 标记，迟到");
  const replica = new ConversationReplica(topic, "new");
  replica.receive(snapshot(5, polluted));
  replica.receive(snapshot(6, correct));
  replica.receive(delta(5, 6, "迟文本**整体替换**实时缓冲并打上 complete 标记，迟"));
  assert.equal(replica.rows[0].text, correct);
  assert.equal(replica.receive(snapshot(4, polluted)), "ignored");
  assert.equal(replica.rows[0].text, correct);
});

test("a missing row makes an entire batch invalid, even if earlier operations were applicable", () => {
  const replica = new ConversationReplica(topic, "new");
  replica.receive(snapshot(5, "原文"));
  const frame = delta(5, 7, "不可提交");
  frame.payload.deltas.push({ op: "row.delta", rowId: 99, path: "text", append: "缺失行" });
  assert.equal(replica.receive(frame), "resync");
  assert.equal(replica.rows[0].text, "原文");
  assert.equal(replica.seq, 5);
});

test("control-only completion is sequenced and an invalid batch cannot change execution state", () => {
  const replica = new ConversationReplica(topic, "new");
  replica.receive({ ...snapshot(5, ""), payload: { kind: "snapshot", snapshot: {
    logEpoch: "epoch", seq: 5, control: { phase: "prewarming", canStop: true }, rows: { window: [] },
  } } });
  assert.equal(replica.control?.phase, "prewarming");
  const control = { op: "state.updated", patch: { control: { phase: "completedInterrupted", canStop: false } } };
  replica.receive({ topic, subscriptionId: "new", fromSeq: 5, toSeq: 6,
    payload: { kind: "deltas", deltas: [control, { op: "row.delta", rowId: 99, path: "text", append: "missing" }] } });
  assert.equal(replica.control?.phase, "prewarming");
  replica.receive({ ...snapshot(6, ""), payload: { kind: "snapshot", snapshot: {
    logEpoch: "epoch", seq: 6, control: { phase: "running", canStop: true }, rows: { window: [] },
  } } });
  assert.equal(replica.receive({ topic, subscriptionId: "new", fromSeq: 6, toSeq: 7,
    payload: { kind: "deltas", deltas: [control] } }), "applied");
  assert.equal(replica.control?.phase, "completedInterrupted");
  assert.equal(replica.control?.canStop, false);
});


test("goal state arrives via snapshot and state patches, clearing on null", () => {
  const replica = new ConversationReplica("conversation/A", "sub");
  replica.receive({ topic: "conversation/A", subscriptionId: "sub", fromSeq: 0, toSeq: 1,
    payload: { kind: "snapshot", snapshot: { logEpoch: "epoch", seq: 1, goal: {
      objective: "发布 1.5 版本",
      status: "active",
      iteration: 2,
      timeUsedSeconds: 90,
      verifications: [
        { anchorTurnId: "t1", anchorRowId: 9, goalIteration: 1, verification: { passed: true } },
        { anchorTurnId: "t2", goalIteration: 2, verification: { passed: false } },
      ],
    }, rows: { window: [] } } } });
  assert.equal(replica.goal?.objective, "发布 1.5 版本");
  assert.equal(replica.goal?.iteration, 2);
  assert.equal(replica.goal?.verifications[1].passed, false);
  assert.equal(replica.goal?.verifications[0].anchorTurnId, "t1");
  assert.equal(replica.goal?.verifications[0].anchorRowId, 9);
  replica.receive({ topic: "conversation/A", subscriptionId: "sub", fromSeq: 1, toSeq: 2,
    payload: { kind: "deltas", deltas: [{ op: "state.updated", patch: { goal: { objective: "发布 1.5 版本", status: "verified", iteration: 3 } } }] } });
  assert.equal(replica.goal?.status, "verified");
  replica.receive({ topic: "conversation/A", subscriptionId: "sub", fromSeq: 2, toSeq: 3,
    payload: { kind: "deltas", deltas: [{ op: "state.updated", patch: { goal: { status: "complete", timeUsedSeconds: 12 } } }] } });
  assert.equal(replica.goal?.status, "verified");
  assert.equal(replica.goal?.objective, "发布 1.5 版本");
  assert.equal(replica.goal?.timeUsedSeconds, 12);
  assert.equal(replica.goal?.iteration, 3);
  replica.receive({ topic: "conversation/A", subscriptionId: "sub", fromSeq: 3, toSeq: 4,
    payload: { kind: "deltas", deltas: [{ op: "state.updated", patch: { goal: { objective: "改用新的目标", status: "active", iteration: 1, timeUsedSeconds: 0, activeRunStartedAtMs: 50 } } }] } });
  assert.equal(replica.goal?.objective, "改用新的目标");
  assert.equal(replica.goal?.activeRunStartedAtMs, 50);
  replica.receive({ topic: "conversation/A", subscriptionId: "sub", fromSeq: 4, toSeq: 5,
    payload: { kind: "deltas", deltas: [{ op: "state.updated", patch: { goal: { timeUsedSeconds: 8 } } }] } });
  assert.equal(replica.goal?.objective, "改用新的目标");
  assert.equal(replica.goal?.timeUsedSeconds, 8);
  replica.receive({ topic: "conversation/A", subscriptionId: "sub", fromSeq: 5, toSeq: 6,
    payload: { kind: "deltas", deltas: [{ op: "state.updated", patch: { goal: null } }] } });
  assert.equal(replica.goal, null);
});

test("queue updates obey the same snapshot, sequence and subscription rules as transcript rows", () => {
  const replica = new ConversationReplica("conversation/A", "sub");
  const queued = { queueItemId: "queue-command", sourceCommandId: "command", text: "待发送" };
  const snapshot = { topic: "conversation/A", subscriptionId: "sub", fromSeq: 0, toSeq: 1, payload: { kind: "snapshot", snapshot: { logEpoch: "epoch", seq: 1, queue: { items: [queued] }, rows: { window: [] } } } };
  assert.equal(replica.receive(snapshot), "applied");
  assert.deepEqual(replica.queue, [{ ...queued, kind: undefined }]);
  const remove = { topic: "conversation/A", subscriptionId: "sub", fromSeq: 1, toSeq: 2, payload: { kind: "deltas", deltas: [{ op: "state.updated", patch: { queue: { items: [] } } }] } };
  assert.equal(replica.receive({ ...remove, subscriptionId: "old" }), "ignored");
  assert.equal(replica.queue?.length, 1);
  assert.equal(replica.receive({ ...remove, fromSeq: 4, toSeq: 5 }), "resync");
  assert.equal(replica.queue?.length, 1);
  assert.equal(replica.receive(snapshot), "applied");
  assert.equal(replica.receive(remove), "applied");
  assert.deepEqual(replica.queue, []);
  assert.equal(replica.receive(remove), "ignored");
});
