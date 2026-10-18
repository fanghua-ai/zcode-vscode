/**
 * Sanitized v4/conversation snapshot for the hidden-runtime-input workbar
 * regression. IDs, timestamps, and text are fixture-only; no user session or
 * database content is included.
 */
export const workbarBackendSnapshot = {
  topic: "conversation/workbar-fixture",
  subscriptionId: "subscription-workbar-fixture",
  fromSeq: 0,
  toSeq: 9,
  payload: {
    kind: "snapshot",
    snapshot: {
      logEpoch: "fixture-epoch",
      seq: 9,
      rows: {
        window: [
          {
            rowId: 1,
            kind: "turnHeader",
            turnId: "fixture-turn-before-runtime-input",
            state: "completedSuccess",
            startedAt: 1_000,
            endedAt: 259_000,
            activeMs: 258_000,
          },
          {
            rowId: 2,
            kind: "userInput",
            turnId: "fixture-turn-before-runtime-input",
            entityId: "fixture-question",
            origin: "realUser",
            text: "FIXTURE_QUESTION",
            createdAt: 1_000,
            actions: { canEdit: true },
          },
          {
            rowId: 3,
            kind: "reasoning",
            turnId: "fixture-turn-before-runtime-input",
            text: "FIXTURE_THOUGHT_BEFORE",
            state: "complete",
            createdAt: 1_000,
          },
          {
            rowId: 4,
            kind: "assistantText",
            turnId: "fixture-turn-before-runtime-input",
            text: "FIXTURE_INTERMEDIATE_REPLY",
            state: "complete",
            createdAt: 200_000,
          },
          {
            rowId: 5,
            kind: "userInput",
            turnId: "fixture-turn-before-runtime-input",
            entityId: "fixture-reminder",
            source: "todo_reminder",
            synthetic: true,
            visibility: "hidden",
            text: "FIXTURE_HIDDEN_REMINDER",
            createdAt: 259_000,
          },
          {
            rowId: 6,
            kind: "turnHeader",
            turnId: "fixture-turn-after-runtime-input",
            state: "completedSuccess",
            startedAt: 259_000,
            endedAt: 351_000,
            activeMs: 92_000,
          },
          {
            rowId: 7,
            kind: "userInput",
            turnId: "fixture-turn-after-runtime-input",
            entityId: "fixture-background-result",
            source: "background_task",
            anchor: { origin: "backgroundResult" },
            semantics: {
              origin: "agent_runtime",
              transcriptVisibility: "hidden",
              uiVisibility: "hidden",
            },
            text: "FIXTURE_HIDDEN_BACKGROUND_RESULT",
            createdAt: 259_000,
          },
          {
            rowId: 8,
            kind: "reasoning",
            turnId: "fixture-turn-after-runtime-input",
            text: "FIXTURE_THOUGHT_AFTER",
            state: "complete",
            createdAt: 259_000,
          },
          {
            rowId: 9,
            kind: "assistantText",
            turnId: "fixture-turn-after-runtime-input",
            text: "FIXTURE_FINAL_REPLY",
            state: "complete",
            createdAt: 351_000,
          },
        ],
      },
    },
  },
} as const;
