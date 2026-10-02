import { basename } from "node:path";
import { str, toAgentKind, type AttentionItem } from "../types.js";

export interface HerdrSession {
  name: string;
  socket_path: string;
  running: boolean;
  machineId?: string;
  label?: string;
  sshTarget?: string;
}

export interface HerdrAgent {
  terminal_id: string;
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent_status: "idle" | "working" | "blocked" | "done" | "unknown";
  agent?: unknown;
  name?: unknown;
  title?: unknown;
  display_agent?: unknown;
  terminal_title_stripped?: unknown;
  cwd?: unknown;
  foreground_cwd?: unknown;
  state_change_seq?: unknown;
  completion_seq?: unknown;
  agent_session?: unknown;
}

export interface HerdrSnapshot {
  agents: HerdrAgent[];
  workspaces: Array<{ workspace_id: string; label?: unknown }>;
  version?: unknown;
  protocol?: unknown;
}

export interface HerdrObservation {
  signature: string;
  sequence?: number;
  completionSequence?: number;
  status: HerdrAgent["agent_status"];
  since?: number;
  observedAt: number;
  pendingCompletion?: string;
  acknowledgedCompletion?: string;
}

export const herdrEntityKey = (session: HerdrSession, terminalId: string): string =>
  `herdr:${JSON.stringify([session.socket_path, terminalId])}`;

export const sequence = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;

/** Normalize semantic agent state, retaining unread work per terminal. */
export function normalizeHerdrAgent(
  session: HerdrSession,
  raw: HerdrAgent,
  workspaceLabel: string,
  previous: HerdrObservation | undefined,
  now: number,
): { item: AttentionItem | null; observation: HerdrObservation } {
  const seq = sequence(raw.state_change_seq);
  // Server completion counters start at one; zero is not a completed turn.
  const completionSeq = sequence(raw.completion_seq);
  const currentCompletion = completionSeq && completionSeq > 0 ? completionSeq : undefined;
  const native = raw.agent_session && typeof raw.agent_session === "object" ? raw.agent_session as Record<string, unknown> : undefined;
  const signature = JSON.stringify([str(raw.agent), native ? [native.source, native.agent, native.kind, native.value] : null]);
  // A restored terminal can retain its identity while its server counters reset.
  const sameOccupant = previous?.signature === signature &&
    !(seq !== undefined && previous.sequence !== undefined && seq < previous.sequence) &&
    !(currentCompletion !== undefined && previous.completionSequence !== undefined && currentCompletion < previous.completionSequence);
  // done -> idle can merely mean another pane in the tab was viewed.
  const semantic = (s: string) => s === "done" ? "idle" : s;
  const changed = sameOccupant && (previous.sequence !== seq || semantic(previous.status) !== semantic(raw.agent_status) ||
    (currentCompletion !== undefined && currentCompletion !== previous.completionSequence));
  const seenBaseline = !sameOccupant && raw.agent_status === "idle" && currentCompletion !== undefined
    ? `completion:${currentCompletion}` : undefined;
  const observation: HerdrObservation = {
    signature, sequence: seq, completionSequence: currentCompletion, status: raw.agent_status, observedAt: sameOccupant ? previous.observedAt : now,
    since: sameOccupant ? changed ? now : previous.since : undefined,
    pendingCompletion: sameOccupant && !changed ? previous.pendingCompletion : undefined,
    // completion_seq records that work completed, independently of viewing.
    // A first idle snapshot is already seen in Herdr; use it as our baseline
    // rather than replaying a historical completion after startup/restart.
    acknowledgedCompletion: sameOccupant ? previous.acknowledgedCompletion : seenBaseline,
  };
  const completion = currentCompletion !== undefined ? `completion:${currentCompletion}` :
    raw.agent_status === "done" ? `state:${seq ?? "unknown"}` : undefined;
  if (completion && completion !== observation.acknowledgedCompletion) observation.pendingCompletion = completion;
  if (raw.agent_status === "working" || raw.agent_status === "blocked" || raw.agent_status === "unknown") {
    observation.pendingCompletion = undefined;
  }
  let reason: AttentionItem["reason"];
  if (raw.agent_status === "working") reason = "waiting";
  else if (raw.agent_status === "blocked") reason = "waiting";
  else if (observation.pendingCompletion) reason = "finished";
  else if (raw.agent_status === "unknown") reason = "unknown";
  else return { item: null, observation };
  const key = herdrEntityKey(session, raw.terminal_id);
  const cwd = str(raw.foreground_cwd) || str(raw.cwd);
  const title = str(raw.title) || str(raw.terminal_title_stripped) || str(raw.name) ||
    str(raw.display_agent) || workspaceLabel || str(raw.agent) || raw.pane_id;
  return {
    observation,
    item: {
      id: key, entityKey: key, source: "herdr", workspaceId: raw.workspace_id,
      herdr: { session: session.name, terminalId: raw.terminal_id, paneId: raw.pane_id, machineId: session.machineId },
      agent: toAgentKind(str(raw.agent)), title,
      repo: `${session.label ? `${session.label}/` : ""}${session.name} · ${workspaceLabel || (cwd ? basename(cwd) : raw.workspace_id)}`,
      reason, activity: raw.agent_status === "working" ? "working" : "waiting",
      needsInput: raw.agent_status === "blocked" ? true : undefined,
      synthetic: raw.agent_status === "working" ? true : undefined,
      activitySince: observation.since, ageUnknown: observation.since === undefined,
      createdAt: new Date(observation.since ?? observation.observedAt).toISOString(),
    },
  };
}
