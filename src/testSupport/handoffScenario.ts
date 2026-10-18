import { ZCodeClient, type HistoryItem } from "../zcodeClient";
import { workbarBackendSnapshot } from "./workbarBackendFixture";

// Exercise actual subscription/snapshot ordering and incremental frames through
// the client, then feed its output into a real browser. No user state is opened.
export async function handoffScenario(reasoning: string, pollutedReasoning?: string) {
  const messages: Record<string, unknown>[] = [];
  let active = "A";
  let seq = 0;
  let subscription = "";
  let subscriptionCount = 0;
  let target = "";
  let answer = "";
  let viewGen = 20;
  const client = new ZCodeClient({ binaryPath: "/unused", workspacePath: "/test",
    onEvent(event) {
      if (event.type === "transcript_sync") {
        messages.push({ type: "history", viewGen, activeSince: Date.now(), ...event.data as object });
      } else if (["assistant_reasoning_delta", "assistant_text_delta", "tool_call"].includes(event.type)) {
        messages.push({ type: event.type, ...event.data as object });
      }
    },
  });
  const state = client as unknown as {
    sessionId: string; subscribeConversation(): Promise<void>;
    handleConversationFrame(event: unknown): void;
    handleSessionEvent(event: unknown): void;
    sendRequest(method: string, params?: unknown): Promise<unknown>;
  };
  const rows = () => active === "A" ? [
    { rowId: 1, kind: "reasoning", text: "Earlier reasoning stays intact.", state: "complete" },
    { rowId: 2, kind: "assistantText", text: "Earlier body stays intact.", state: "complete" },
    { rowId: 3, kind: "reasoning", text: target, state: "streaming" },
    ...(answer ? [{ rowId: 4, kind: "assistantText", text: answer, state: "streaming" }] : []),
  ] : [];
  const snapshot = () => ({ topic: `conversation/${active}`, subscriptionId: subscription,
    fromSeq: 0, toSeq: seq, payload: { kind: "snapshot", snapshot: {
      logEpoch: "epoch", seq, rows: { window: rows(), totalCount: rows().length },
    } } });
  state.sendRequest = async method => {
    if (method === "v4/conversation/subscribe") {
      subscription = `sub-${++subscriptionCount}`;
      // The server can deliver the snapshot BEFORE the subscribe response.
      state.handleConversationFrame({ kind: "complete", frame: snapshot() });
      return { ack: { subscriptionId: subscription, logEpoch: "epoch" } };
    }
    if (method === "v4/conversation/resync") {
      state.handleConversationFrame(snapshot());
      return { ack: { subscriptionId: subscription } };
    }
    return {};
  };
  const switchTo = async (sessionId: string) => {
    await client.prepareViewChange();
    messages.push({ type: "view_reset", viewGen: ++viewGen });
    const oldSubscription = subscription;
    active = sessionId;
    state.sessionId = sessionId;
    await state.subscribeConversation();
    // Delayed old subscription frames must be ignored, even for the same topic.
    state.handleConversationFrame({ ...snapshot(), subscriptionId: oldSubscription,
      payload: { kind: "deltas", deltas: [{ op: "row.delta", rowId: 3, path: "text", append: "旧订阅重复文字" }] } });
    messages.push({ type: "session_ready", sessionId: active, viewGen });
    const history = await client.loadHistory();
    messages.push({ type: "history", sessionId: active, viewGen, activeSince: Date.now(), ...history });
    client.endViewChange();
  };
  const stream = (kind: "reasoning" | "text", append: string) => {
    const fromSeq = seq++;
    const isNewAnswer = kind === "text" && !answer;
    if (kind === "reasoning") target += append;
    else answer += append;
    const frame = { topic: "conversation/A", subscriptionId: subscription, fromSeq, toSeq: seq,
      payload: { kind: "deltas", deltas: isNewAnswer
        ? [{ op: "row.appended", row: { rowId: 4, kind: "assistantText", text: answer, state: "streaming" } }]
        : [{ op: "row.delta", rowId: kind === "reasoning" ? 3 : 4, path: "text", append }] } };
    if (active === "A") {
      state.handleConversationFrame(frame);
      state.handleConversationFrame(frame); // Retransmission of the same batch.
    }
    // Legacy model events have no character offsets and must never be mixed in.
    state.handleSessionEvent({ sessionId: "A", type: "model.streaming", timestamp: 100,
      payload: { kind: `${kind}_delta`, assistantMessageId: "target", delta: append } });
  };
  await switchTo("A");
  const streamed = pollutedReasoning ?? reasoning;
  const width = Math.ceil(streamed.length / 5);
  for (let offset = 0; offset < streamed.length; offset += width) {
    stream("reasoning", streamed.slice(offset, offset + width));
    await switchTo("B");
    await switchTo("A");
  }
  if (pollutedReasoning !== undefined) {
    target = reasoning;
    seq++;
    // Correct an already displayed polluted buffer with an authoritative snapshot.
    state.handleConversationFrame(snapshot());
    await switchTo("B");
    await switchTo("A");
    state.handleSessionEvent({ sessionId: "A", type: "model.streaming",
      payload: { kind: "reasoning_delta", delta: pollutedReasoning } });
  }
  stream("text", "The complete answer.");
  await switchTo("B");
  stream("text", " The continuation.");
  await switchTo("A");
  client.dispose();
  return { messages, reasoning, answer: "The complete answer. The continuation." };
}

/**
 * Feed the sanitized backend snapshot through the real client projection. The
 * browser regression consumes these projected history items, so it covers the
 * backend-to-workbar path without opening any real session or database.
 */
export async function workbarBackendScenario(): Promise<HistoryItem[]> {
  const client = new ZCodeClient({ binaryPath: "/unused", workspacePath: "/test", onEvent: () => {} });
  const state = client as unknown as {
    sessionId: string;
    subscribeConversation(): Promise<void>;
    handleConversationFrame(event: unknown): void;
    sendRequest(method: string, params?: unknown): Promise<unknown>;
  };
  state.sessionId = "workbar-fixture";
  state.sendRequest = async (method, params) => {
    if (method === "v4/conversation/subscribe" &&
      (params as { topic?: string })?.topic === workbarBackendSnapshot.topic) {
      state.handleConversationFrame(structuredClone(workbarBackendSnapshot));
      return { ack: { subscriptionId: workbarBackendSnapshot.subscriptionId, logEpoch: "fixture-epoch" } };
    }
    return {};
  };
  try {
    await client.prepareViewChange();
    await state.subscribeConversation();
    return (await client.loadHistory()).items;
  } finally {
    client.dispose();
  }
}
