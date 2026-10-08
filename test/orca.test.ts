import { test } from "node:test";
import assert from "node:assert/strict";
import { OrcaClient } from "../src/core/orca/client.js";
import { normalizeWorktrees, type RawOrcaTerminal } from "../src/core/orca/normalize.js";
import { Store } from "../src/core/services/store.js";
import { resolveConfig } from "../src/config.js";

const now = "2026-06-23T12:00:00Z";
const terminal = (leaf: string, extra: Partial<RawOrcaTerminal> = {}): RawOrcaTerminal => ({
  handle: `term-${leaf}`, worktreeId: "repo::/project", tabId: "tab", leafId: leaf,
  agentIdentity: "omp", connected: true, title: `Agent ${leaf}`, ...extra,
});
const agent = (leaf: string, state: string, extra = {}) => ({
  paneKey: `tab:${leaf}`, agentType: "omp", state, taskTitle: `Task ${leaf}`,
  stateStartedAt: Date.parse(now) - 5000, ...extra,
});
const worktree = (agents: unknown[]) => ({ worktreeId: "repo::/project", displayName: "project", agents });

function clientWithResponses(ps: unknown, terminals: unknown, switchResult: unknown = { ok: true }) {
  const switched: string[] = [];
  const client = new OrcaClient({
    bin: "orca-test", now: () => Date.parse(now),
    runner: async (_bin, args) => {
      const response = args[0] === "worktree" ? ps : args[1] === "list" ? { ok: true, result: { terminals } } : switchResult;
      if (args[1] === "switch") switched.push(args[3]);
      return { stdout: JSON.stringify(response), stderr: "" };
    },
  });
  return { client, switched };
}

test("agents sharing a worktree stay independent and Decisions contains only requests or failures", () => {
  const panes = ["working", "waiting", "blocked", "done", "interrupted"];
  const agents = panes.map(leaf => agent(leaf, leaf === "interrupted" ? "done" : leaf, { interrupted: leaf === "interrupted" }));
  agents.push(agent("closed", "blocked"));
  const items = normalizeWorktrees([worktree(agents)], now, panes.map(leaf => terminal(leaf)));
  const store = new Store([], () => Date.parse(now), 15);
  store.setAttention(items, false, "orca");
  assert.deepEqual(new Set(store.getState().items.map(item => item.title)), new Set(panes.map(leaf => `Task ${leaf}`)));
  assert.equal(items.find(item => item.title === "Task working")?.activity, "working");
  assert.equal(items.find(item => item.title === "Task done")?.reason, "finished");
  store.cycleView();
  assert.deepEqual(new Set(store.getState().items.map(item => item.title)), new Set(["Task waiting", "Task blocked", "Task interrupted"]));
});

test("terminal leaf identity, not a stale agent record or a neighboring pane, determines the displayed agent", () => {
  const items = normalizeWorktrees([worktree([
    agent("left", "working", { updatedAt: 1 }),
    agent("left", "blocked", { updatedAt: 2, agentType: "opencode" }),
    agent("missing", "waiting"),
  ])], now, [terminal("left"), terminal("right", { connected: false })]);
  assert.deepEqual(items.map(item => [item.agent, item.reason, item.orca?.terminalHandle]), [["opencode", "blocked", "term-left"]]);
});

test("floating agents have unknown lifecycle while disconnected agents and ordinary shells are absent", () => {
  const items = normalizeWorktrees([], now, [
    terminal("floating", { worktreeId: "global-floating-terminal" }),
    terminal("closed", { connected: false }),
    terminal("shell", { agentIdentity: null }),
  ]);
  assert.deepEqual(items.map(item => [item.reason, item.activity, item.needsInput, item.ageUnknown]), [["unknown", "waiting", undefined, true]]);
  const store = new Store();
  store.setAttention(items, false, "orca");
  store.cycleView();
  assert.deepEqual(store.getState().items, []);
});

test("focus switches the selected live terminal rather than its newer neighboring agent", async () => {
  const selected = normalizeWorktrees([worktree([agent("left", "waiting")])], now, [terminal("left")])[0];
  const { client, switched } = clientWithResponses({}, [terminal("right"), terminal("left")]);
  await client.focus(selected);
  assert.deepEqual(switched, ["term-left"]);
});

test("closing or replacing the selected pane cannot redirect focus to another agent", async () => {
  const selected = normalizeWorktrees([worktree([agent("left", "waiting")])], now, [terminal("left")])[0];
  for (const remaining of [[terminal("right")], [terminal("right", { handle: "term-left" })], [terminal("left", { connected: false })]]) {
    const { client, switched } = clientWithResponses({}, remaining);
    await assert.rejects(client.focus(selected), /closed or replaced/);
    assert.deepEqual(switched, []);
  }
});

test("runtime failures and malformed inventories reject instead of clearing last-good attention", async () => {
  const selected = normalizeWorktrees([worktree([agent("left", "waiting")])], now, [terminal("left")])[0];
  const failure = { ok: false, error: { code: "runtime_unreachable", message: "down" } };
  const { client } = clientWithResponses(failure, [terminal("left")], failure);
  await assert.rejects(client.listAttention(), /worktree ps failed/);
  await assert.rejects(client.focus(selected), /terminal switch failed/);
  const malformed = clientWithResponses({ ok: true, result: { worktrees: [] } }, null).client;
  await assert.rejects(malformed.listAttention(), /terminals is not an array/);
});

test("listAttention keeps concurrent Orca and floating agents with their exact focus identity", async () => {
  const terminals = [terminal("left"), terminal("right"), terminal("floating", { worktreeId: "global-floating-terminal", agentIdentity: "claude" })];
  const { client } = clientWithResponses({ ok: true, result: { worktrees: [worktree([agent("left", "working"), agent("right", "blocked")])] } }, terminals);
  const items = await client.listAttention();
  assert.deepEqual(items.map(item => [item.orca?.terminalHandle, item.reason]), [["term-left", "waiting"], ["term-right", "blocked"], ["term-floating", "unknown"]]);
});

test("configuration preserves explicit Orca command and accepts OpenCode aliases", () => {
  const config = resolveConfig({ orcaBin: " /opt/orca/custom ", agentAliases: { fork: "opencode" }, orcaPollMs: 1 });
  assert.equal(config.orcaBin, "/opt/orca/custom");
  assert.deepEqual(config.agentAliases, { fork: "opencode" });
  assert.equal(config.orcaPollMs, 500);
});
