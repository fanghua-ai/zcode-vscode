/** A `/goal` or `/target` line the app-server executes as goal state, not as a prompt. */
export type GoalCommand =
  | { kind: "set"; objective: string; displayText: string }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" };

const GOAL_LINE = /^\/(?:goal|target)(?:\s+([\s\S]*))?$/i;

/**
 * Desktop submits a goal with the `sendGoalCommand` protocol command. A normal
 * `sendText` of the same characters never creates session goal state, so the
 * status bar stays empty. Pause, resume, and clear are the other goal verbs.
 */
export function parseGoalCommand(text: string): GoalCommand | null {
  const trimmed = text.trim();
  const match = GOAL_LINE.exec(trimmed);
  if (!match) return null;
  const rest = (match[1] ?? "").trim();
  if (!rest) return null;
  const head = rest.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (head === "pause") return { kind: "pause" };
  if (head === "resume") return { kind: "resume" };
  if (head === "clear") return { kind: "clear" };
  if (head === "replace") {
    const objective = rest.slice(head.length).trim();
    return { kind: "set", objective, displayText: trimmed };
  }
  return { kind: "set", objective: rest, displayText: trimmed };
}
