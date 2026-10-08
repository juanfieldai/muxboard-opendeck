import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { OrcaClient } from "../src/core/orca/client.js";
import { normalizeWorktrees, type RawOrcaTerminal } from "../src/core/orca/normalize.js";
import { Store } from "../src/core/services/store.js";
import { resolveConfig } from "../src/config.js";
import { OpenDeckHost } from "../src/opendeck.js";
import type { AttentionItem } from "../src/core/types.js";

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

function deckClient(terminals: RawOrcaTerminal[], calls: string[][], response: unknown = { ok: true, result: { terminal: { handle: "created" } } }) {
  return new OrcaClient({
    bin: "orca-test",
    runner: async (_bin, args) => {
      calls.push(args);
      if (args[0] === "terminal" && args[1] === "list") return { stdout: JSON.stringify({ ok: true, result: { terminals } }), stderr: "" };
      return { stdout: JSON.stringify(response), stderr: "" };
    },
  });
}

function deckItem(workspaceId = "repo::/project") {
  return normalizeWorktrees([worktree([agent("left", "waiting")])], now, [terminal("left", { worktreeId: workspaceId })])[0];
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


test("deck actions validate the selected pane and send one exact workspace argv", async () => {
  const selected = deckItem();
  const shellCalls: string[][] = [];
  await deckClient([terminal("left")], shellCalls).runDeckAction("shell", selected);
  assert.deepEqual(shellCalls, [
    ["terminal", "list", "--json"],
    ["terminal", "create", "--worktree", "id:repo::/project", "--title", "Shell", "--focus", "--json"],
  ]);

  const changesCalls: string[][] = [];
  await deckClient([terminal("left")], changesCalls, { ok: true, result: { opened: true } }).runDeckAction("changes", selected);
  assert.deepEqual(changesCalls, [
    ["terminal", "list", "--json"],
    ["file", "open-changed", "--worktree", "id:repo::/project", "--mode", "diff", "--json"],
  ]);
});

test("deck agent command is one shell-quoted argv value and preserves workspace text", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "muxboard-orca-"));
  const specialDir = join(tempRoot, "agent's bin");
  mkdirSync(specialDir);
  const executable = join(specialDir, "opencode");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = [specialDir, previousPath].filter(Boolean).join(delimiter);
  try {
    const selected = deckItem("repo::/project; echo INJECTION");
    const calls: string[][] = [];
    await deckClient([terminal("left", { worktreeId: "repo::/project; echo INJECTION" })], calls).runDeckAction("opencode", selected);
    assert.equal(calls[1]?.[0], "terminal");
    assert.equal(calls[1]?.[1], "create");
    assert.equal(calls[1]?.[2], "--worktree");
    assert.equal(calls[1]?.[3], "id:repo::/project; echo INJECTION");
    assert.equal(calls[1]?.[4], "--command");
    const quotedExecutable = "'" + executable.replaceAll("'", "'\\''") + "'";
    assert.equal(calls[1]?.[5], quotedExecutable);
    assert.equal(calls[1]?.[6], "--title");
    assert.equal(calls[1]?.[7], "OpenCode");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("deck actions reject floating, closed, failed, and incomplete targets without creating anything", async () => {
  const floating = normalizeWorktrees([], now, [terminal("floating", { worktreeId: "global-floating-terminal" })])[0];
  const floatingCalls: string[][] = [];
  await assert.rejects(deckClient([terminal("floating", { worktreeId: "global-floating-terminal" })], floatingCalls).runDeckAction("shell", floating), /floating/);
  assert.deepEqual(floatingCalls, []);

  const closedCalls: string[][] = [];
  await assert.rejects(deckClient([terminal("right")], closedCalls).runDeckAction("shell", deckItem()), /closed or replaced/);
  assert.deepEqual(closedCalls, [["terminal", "list", "--json"]]);

  const failedCalls: string[][] = [];
  const failed = new OrcaClient({
    bin: "orca-test",
    runner: async (_bin, args) => {
      failedCalls.push(args);
      return { stdout: JSON.stringify({ ok: false, error: { code: "runtime", message: "down" } }), stderr: "" };
    },
  });
  await assert.rejects(failed.runDeckAction("shell", deckItem()), /terminal list failed/);
  assert.deepEqual(failedCalls, [["terminal", "list", "--json"]]);

  const incompleteCalls: string[][] = [];
  await assert.rejects(deckClient([terminal("left")], incompleteCalls, { ok: true, result: {} }).runDeckAction("shell", deckItem()), /missing created terminal/);
  assert.equal(incompleteCalls.length, 2);
});

function nativeDeck() {
  const messages: Array<{ event: string; context?: string; payload?: { image?: string } }> = [];
  const calls: string[][] = [];
  const terminals = [terminal("left"), terminal("right")];
  const host = new OpenDeckHost({ port: 1, pluginUUID: "native-test", registerEvent: "registerPlugin" }, { info() {}, warn() {}, error() {} });
  const consumer = host as unknown as {
    receive(raw: Buffer): void;
    store: Store;
    orca: OrcaClient;
    socket: { readyState: number; send(message: string): void; close(): void };
  };
  consumer.socket = { readyState: 1, send: message => messages.push(JSON.parse(message)), close() { this.readyState = 3; } };
  consumer.orca = deckClient(terminals, calls);
  const items = normalizeWorktrees([worktree([agent("left", "waiting"), agent("right", "done")])], now, terminals);
  consumer.store.setAttention(items, false, "orca");
  const event = (event: string, context: string, payload = {}) => consumer.receive(Buffer.from(JSON.stringify({ event, context, payload })));
  const appear = (context: string, action: string, controller: string, row: number, column: number) => consumer.receive(Buffer.from(JSON.stringify({ event: "willAppear", context, action: `com.juanfieldai.muxboard.${action}`, payload: { controller, coordinates: { row, column } } })));
  appear("Keypad.15.0", "controls", "Keypad", 5, 0);
  appear("Keypad.16.0", "controls", "Keypad", 5, 1);
  appear("Encoder.0.0", "controls", "Encoder", 0, 0);
  appear("Infobar.0.0", "lcd", "Infobar", 0, 0);
  const banner = () => {
    const image = messages.filter(message => message.event === "setImage" && message.context === "Infobar.0.0").at(-1)?.payload?.image;
    assert.ok(image, "native LCD receives a banner");
    return Buffer.from(image.split(",")[1], "base64").toString();
  };
  const tap = (context: string) => { event("keyDown", context); event("keyUp", context); };
  return { host, consumer, calls, messages, items, event, appear, banner, tap };
}

test("native LCD renders the full banner without writing images to screenless controls", () => {
  const deck = nativeDeck();
  try {
    assert.match(deck.banner(), /Task left/);
    deck.event("dialRotate", "Encoder.0.0", { ticks: 1 });
    assert.match(deck.banner(), /Task right/);
    assert.ok(deck.messages.filter(message => message.event === "setImage").every(message => message.context === "Infobar.0.0"));
    deck.event("willDisappear", "Infobar.0.0");
    const before = deck.messages.length;
    deck.event("dialRotate", "Encoder.0.0", { ticks: -1 });
    assert.equal(deck.messages.length, before, "disappeared LCD no longer receives frames");
  } finally { deck.host.shutdown(); }
});

test("native knob selects without focus, Button A focuses needs, and Button B toggles All and Needs", async () => {
  const deck = nativeDeck();
  try {
    deck.event("dialRotate", "Encoder.0.0", { ticks: 1 });
    assert.deepEqual(deck.calls, []);
    deck.event("dialDown", "Encoder.0.0");
    deck.tap("Keypad.15.0");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(deck.calls.filter(args => args[1] === "switch"), [
      ["terminal", "switch", "--terminal", "term-right", "--json"],
      ["terminal", "switch", "--terminal", "term-left", "--json"],
    ]);
    deck.tap("Keypad.16.0");
    assert.deepEqual(deck.consumer.store.getState().items.map(item => item.title), ["Task left"]);
    deck.tap("Keypad.16.0");
    assert.equal(deck.consumer.store.getState().items.length, 2);
  } finally { deck.host.shutdown(); }
});

test("Button B hold opens Actions without filtering and keeps the captured workspace target across polls", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const deck = nativeDeck();
  try {
    deck.event("keyDown", "Keypad.16.0");
    t.mock.timers.tick(600);
    deck.event("keyUp", "Keypad.16.0");
    assert.equal(deck.consumer.store.getState().view, "queue");
    deck.consumer.store.setAttention([deck.items[1]], false, "orca");
    assert.match(deck.banner(), /Task left/);
    deck.event("dialDown", "Encoder.0.0");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(deck.calls.find(args => args[1] === "switch"), ["terminal", "switch", "--terminal", "term-left", "--json"]);
    deck.event("dialRotate", "Encoder.0.0", { ticks: 1 });
    deck.event("dialDown", "Encoder.0.0");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(deck.calls.find(args => args[1] === "create"), ["terminal", "create", "--worktree", "id:repo::/project", "--title", "Shell", "--focus", "--json"]);
  } finally { deck.host.shutdown(); }
});

test("disappearing Button B cancels its hold and stale release cannot toggle the new context", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const deck = nativeDeck();
  try {
    deck.event("keyDown", "Keypad.16.0");
    t.mock.timers.tick(300);
    deck.event("willDisappear", "Keypad.16.0");
    t.mock.timers.tick(600);
    deck.appear("Keypad.16.0", "controls", "Keypad", 5, 1);
    deck.event("keyUp", "Keypad.16.0");
    assert.equal(deck.consumer.store.getState().view, "queue");
    deck.tap("Keypad.16.0");
    assert.equal(deck.consumer.store.getState().view, "decisions");
  } finally { deck.host.shutdown(); }
});

test("native agent key release focuses its key-down target while a held agent only snoozes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const deck = nativeDeck();
  try {
    deck.appear("Keypad.0.0", "agent", "Keypad", 0, 0);
    deck.event("keyDown", "Keypad.0.0");
    const replacement: AttentionItem = { ...deck.items[1], reason: "blocked" };
    deck.consumer.store.setAttention([replacement], false, "orca");
    deck.event("keyUp", "Keypad.0.0");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(deck.calls.find(args => args[1] === "switch"), ["terminal", "switch", "--terminal", "term-left", "--json"]);
    deck.calls.length = 0;
    deck.event("keyDown", "Keypad.0.0");
    t.mock.timers.tick(600);
    deck.event("keyUp", "Keypad.0.0");
    assert.deepEqual(deck.calls, []);
    assert.deepEqual(deck.consumer.store.getState().items, []);
  } finally { deck.host.shutdown(); }
});

test("native action keys run the captured target on tap but never execute on hold", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const deck = nativeDeck();
  try {
    deck.event("keyDown", "Keypad.16.0");
    t.mock.timers.tick(600);
    deck.event("keyUp", "Keypad.16.0");
    deck.appear("Keypad.0.0", "agent", "Keypad", 0, 0);
    deck.event("keyDown", "Keypad.0.0");
    t.mock.timers.tick(600);
    deck.event("keyUp", "Keypad.0.0");
    assert.deepEqual(deck.calls, []);
    deck.event("keyDown", "Keypad.0.0");
    deck.consumer.store.setAttention([deck.items[1]], false, "orca");
    deck.event("keyUp", "Keypad.0.0");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(deck.calls.find(args => args[1] === "switch"), ["terminal", "switch", "--terminal", "term-left", "--json"]);
  } finally { deck.host.shutdown(); }
});
