import { type AttentionItem, type AttentionReason, str, toAgentKind } from "../types.js";

interface RawOrcaAgent {
  paneKey?: unknown;
  state?: unknown;
  agentType?: unknown;
  displayName?: unknown;
  taskTitle?: unknown;
  interrupted?: unknown;
  stateStartedAt?: unknown;
  updatedAt?: unknown;
}

interface RawOrcaWorktree {
  worktreeId?: unknown;
  repo?: unknown;
  displayName?: unknown;
  lastOutputAt?: unknown;
  agents?: unknown;
}

export interface RawOrcaTerminal {
  handle?: unknown;
  worktreeId?: unknown;
  tabId?: unknown;
  leafId?: unknown;
  agentIdentity?: unknown;
  title?: unknown;
  connected?: unknown;
}

/** The terminal inventory establishes liveness; worktree agents supply lifecycle state. */
export function normalizeWorktrees(raw: unknown, nowIso: string, terminals: RawOrcaTerminal[]): AttentionItem[] {
  const worktrees = new Map<string, RawOrcaWorktree>();
  const agents = new Map<string, RawOrcaAgent>();
  if (Array.isArray(raw)) {
    for (const row of raw) {
      if (!row || typeof row !== "object") continue;
      const wt = row as RawOrcaWorktree;
      const id = str(wt.worktreeId);
      if (!id) continue;
      worktrees.set(id, wt);
      if (!Array.isArray(wt.agents)) continue;
      for (const value of wt.agents) {
        if (!value || typeof value !== "object") continue;
        const agent = value as RawOrcaAgent;
        const pane = str(agent.paneKey);
        if (!pane) continue;
        const key = `${id}:${pane}`;
        const previous = agents.get(key);
        const updated = typeof agent.updatedAt === "number" ? agent.updatedAt : 0;
        const previousUpdated = typeof previous?.updatedAt === "number" ? previous.updatedAt : 0;
        if (!previous || updated >= previousUpdated) agents.set(key, agent);
      }
    }
  }

  const items: AttentionItem[] = [];
  for (const terminal of terminals) {
    if (!terminal || typeof terminal !== "object" || terminal.connected !== true) continue;
    const handle = str(terminal.handle);
    const workspaceId = str(terminal.worktreeId);
    if (!handle || !workspaceId) continue;
    const tabId = str(terminal.tabId);
    const leafId = str(terminal.leafId);
    const paneKey = tabId && leafId ? `${tabId}:${leafId}` : undefined;
    const agent = paneKey ? agents.get(`${workspaceId}:${paneKey}`) : undefined;
    // Ordinary shells are not agents, including shells in the floating-terminal workspace.
    if (!agent && !str(terminal.agentIdentity)) continue;
    const wt = worktrees.get(workspaceId);
    const state = str(agent?.state);
    let reason: AttentionReason = "unknown";
    if (state === "done") reason = agent?.interrupted === true ? "failed" : "finished";
    else if (state === "blocked") reason = "blocked";
    else if (state === "waiting" || state === "working") reason = "waiting";
    const needsInput = state === "waiting" || state === "blocked";
    const timestamp = agent?.stateStartedAt ?? agent?.updatedAt;
    const since = typeof timestamp === "number" && Number.isFinite(timestamp) && Number.isFinite(new Date(timestamp).getTime()) ? timestamp : undefined;
    const entityKey = `orca:${workspaceId}:${paneKey ?? handle}`;
    items.push({
      id: entityKey,
      entityKey,
      source: "orca",
      agent: toAgentKind(str(agent?.agentType) || str(terminal.agentIdentity)),
      workspaceId,
      orca: { paneKey, terminalHandle: handle },
      repo: str(wt?.repo) || undefined,
      title: str(agent?.taskTitle) || str(agent?.displayName) || str(terminal.title) || str(wt?.displayName) || handle,
      reason,
      activity: state === "working" ? "working" : "waiting",
      needsInput: needsInput || undefined,
      activitySince: since,
      ageUnknown: since == null,
      createdAt: since == null ? nowIso : new Date(since).toISOString(),
      synthetic: state === "working" || undefined,
    });
  }
  return items;
}
