import { test } from "node:test";
import assert from "node:assert/strict";
import { HerdrClient } from "../src/core/herdr/client.js";
import { HerdrService } from "../src/core/services/herdrService.js";
import { Store } from "../src/core/services/store.js";
import { type HerdrAgent, type HerdrSnapshot } from "../src/core/herdr/normalize.js";
import type { CommandRunner } from "../src/core/exec.js";
import { posixQuote } from "../src/core/herdr/client.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const NOW = Date.parse("2026-10-02T12:00:00Z");
function agent(over: Partial<HerdrAgent> = {}): HerdrAgent {
  return { terminal_id: "term_1", pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "claude", agent_status: "working", state_change_seq: 7, ...over };
}
function snap(agents: HerdrAgent[]): HerdrSnapshot {
  return { version: "0.9.0", protocol: 22, agents, workspaces: [{ workspace_id: "w1", label: "project" }] };
}
function harness(options: { remote?: boolean; sessions?: string[]; machines?: string[]; legacy?: boolean; sshTarget?: string } = {}) {
  let now = NOW;
  const calls: string[][] = [];
  const sshCalls: string[][] = [];
  const sessions = [{ name: "default", running: true, socket_path: "/tmp/default.sock" }, { name: "review", running: true, socket_path: "/tmp/review.sock" }];
  const machines = [{ id: "m1", label: "server", session: "default", enabled: true, target: options.sshTarget ?? "user@server.example" }];
  const data = new Map<string, HerdrSnapshot | Error | string>([["default", snap([agent()])], ["review", snap([agent({ agent: "codex", agent_status: "blocked" })])], ["m1", snap([agent()])]]);
  let focusError = false;
  let focusHook: (() => Promise<void>) | undefined;
  let discoveryError = false;
  const runner: CommandRunner = async (_bin, args) => {
    calls.push([...args]);
    let response: unknown;
    if (args[0] === "session") {
      if (discoveryError) throw new Error("inventory unavailable");
      response = { sessions };
    } else if (args[0] === "machine") response = machines;
    else {
      const target = args[1];
      if (target === "m1" && options.legacy) throw new Error("remote Herdr does not support machine API forwarding; update Herdr on this machine");
      const value = data.get(target);
      if (value instanceof Error) throw value;
      if (typeof value === "string") return { stdout: value, stderr: "" };
      if (args.includes("snapshot")) response = { id: "snapshot", result: { type: "session_snapshot", snapshot: value } };
      else if (args.includes("tab") && args.includes("focus")) response = { result: { type: "tab_info", tab: { tab_id: args.at(-1), workspace_id: value?.agents.find(a => a.tab_id === args.at(-1))?.workspace_id } } };
      else if (args.includes("focus")) {
        await focusHook?.();
        response = focusError ? { error: { code: "gone", message: "removed" } } : { result: { type: "agent_info", agent: value?.agents.find(a => a.pane_id === args.at(-1)) } };
      }
    }
    return { stdout: JSON.stringify(response), stderr: "" };
  };
  const sshRunner: CommandRunner = async (bin, args) => {
    assert.equal(bin, "ssh");
    sshCalls.push(args);
    const value = data.get("m1");
    if (value instanceof Error) throw value;
    if (typeof value === "string") return { stdout: value, stderr: "" };
    const result = args.at(-1)!.includes("'tab' 'focus'") ? { type: "tab_info", tab: { tab_id: value?.agents[0].tab_id, workspace_id: value?.agents[0].workspace_id } } : args.at(-1)!.includes("'focus'") ? { type: "agent_info", agent: value?.agents[0] } : { type: "session_snapshot", snapshot: value };
    return { stdout: JSON.stringify({ result }), stderr: "" };
  };
  const client = new HerdrClient({ runner, sshRunner, now: () => now, includeMachines: options.remote ?? false, sessions: options.sessions, machines: options.machines });
  return { client, runner, calls, sshCalls, sessions, machines, data, setNow: (n: number) => { now = n; }, setFocusHook: (hook: () => Promise<void>) => { focusHook = hook; }, failFocus: () => { focusError = true; }, failDiscovery: () => { discoveryError = true; } };
}

test("Herdr polls every running named session without workspace/terminal collisions", async () => {
  const h = harness();
  const rows = await h.client.listAttention();
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].entityKey, rows[1].entityKey);
  assert.equal(rows[0].workspaceId, rows[1].workspaceId);
  assert.equal(rows[1].needsInput, true);
  assert.ok(rows.every(r => r.ageUnknown && r.activitySince === undefined));
  assert.deepEqual(h.calls[0], ["session", "list", "--json"]);
  assert.deepEqual(h.calls.slice(1), [["--session", "default", "api", "snapshot"], ["--session", "review", "api", "snapshot"]]);
});

test("Herdr local allowlist excludes stopped sessions and uses argument arrays", async () => {
  const h = harness({ sessions: ["review"] });
  h.sessions[0].running = false;
  assert.equal((await h.client.listAttention()).length, 1);
  assert.ok(h.calls.every(c => !c.includes("default")));
});

test("Herdr keeps distinct panes inside one workspace", async () => {
  const h = harness({ sessions: ["default"] });
  h.data.set("default", snap([agent(), agent({ terminal_id: "term_2", pane_id: "w1:p2", agent_status: "blocked" })]));
  const rows = await h.client.listAttention();
  const store = new Store();
  store.setAttention(rows, false, "herdr");
  assert.equal(store.getState().items.length, 2);
});

test("Herdr normalizes done, idle and unknown without inventing activity", async () => {
  const h = harness({ sessions: ["default"] });
  h.data.set("default", snap([agent({ agent_status: "done" }), agent({ terminal_id: "term_2", pane_id: "w1:p2", agent_status: "idle" }), agent({ terminal_id: "term_3", pane_id: "w1:p3", agent_status: "unknown", agent: "new-agent" })]));
  const rows = await h.client.listAttention();
  assert.deepEqual(rows.map(r => r.reason), ["finished", "unknown"]);
  assert.equal(rows[1].agent, "unknown");
  assert.equal(rows[1].needsInput, undefined);
});

test("Herdr modern startup omits seen idle completions but surfaces native done", async () => {
  const h = harness({ sessions: ["default"] });
  h.data.set("default", snap([agent({ agent_status: "idle", completion_seq: 7 }), agent({ terminal_id: "term_2", pane_id: "w1:p2", agent_status: "done", completion_seq: 8 })]));
  const rows = await h.client.listAttention();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].herdr?.terminalId, "term_2");
  assert.equal(rows[0].reason, "finished");
  assert.equal(rows[0].ageUnknown, true);
  assert.equal((await h.client.listAttention()).length, 1);
});

test("Herdr restart after acknowledgment does not replay an already seen completion", async () => {
  const h = harness({ sessions: ["default"] });
  h.data.set("default", snap([agent({ agent_status: "done", completion_seq: 7 })]));
  const [row] = await h.client.listAttention();
  await h.client.focus(row);
  h.data.set("default", snap([agent({ agent_status: "idle", completion_seq: 7 })]));
  const restarted = new HerdrClient({ runner: h.runner, includeMachines: false, sessions: ["default"] });
  assert.deepEqual(await restarted.listAttention(), []);
  assert.deepEqual(await restarted.listAttention(), []);
});

test("Herdr seen startup baseline still surfaces a later observed completion", async () => {
  const h = harness({ sessions: ["default"] });
  h.data.set("default", snap([agent({ agent_status: "idle", completion_seq: 7 })]));
  assert.deepEqual(await h.client.listAttention(), []);
  h.data.set("default", snap([agent({ agent_status: "working", state_change_seq: 8 })]));
  assert.equal((await h.client.listAttention())[0].activity, "working");
  h.data.set("default", snap([agent({ agent_status: "idle", state_change_seq: 9, completion_seq: 9 })]));
  const [finished] = await h.client.listAttention();
  assert.equal(finished.reason, "finished");
  assert.equal(finished.herdr?.terminalId, "term_1");
});

test("Herdr modern observed sibling completion survives tab-wide seen until its own acknowledgment", async () => {
  const h = harness({ sessions: ["default"] });
  const first = agent({ agent_status: "done", completion_seq: 7 });
  const second = agent({ terminal_id: "term_2", pane_id: "w1:p2", agent_status: "done", completion_seq: 8 });
  h.data.set("default", snap([first, second]));
  const [row] = await h.client.listAttention();
  await h.client.focus(row);
  h.data.set("default", snap([{ ...first, agent_status: "idle" }, { ...second, agent_status: "idle" }]));
  const [remaining] = await h.client.listAttention();
  assert.equal(remaining.herdr?.terminalId, "term_2");
  assert.equal(remaining.reason, "finished");
  await h.client.focus(remaining);
  assert.deepEqual(await h.client.listAttention(), []);
});

test("Herdr records local transition age but never treats state_change_seq as a timestamp", async () => {
  const h = harness({ sessions: ["default"] });
  await h.client.listAttention();
  h.setNow(NOW + 6000);
  h.data.set("default", snap([agent({ agent_status: "blocked", state_change_seq: 8 })]));
  const [row] = await h.client.listAttention();
  assert.equal(row.activitySince, NOW + 6000);
  assert.equal(row.ageUnknown, false);
  assert.equal(row.createdAt, new Date(NOW + 6000).toISOString());
});

test("Herdr partial failure retains only that session's last-good rows", async () => {
  const h = harness();
  await h.client.listAttention();
  h.data.set("review", new Error("down"));
  h.data.set("default", snap([]));
  const rows = await h.client.listAttention();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].herdr?.session, "review");
  assert.equal(h.client.health.successful, 1);
  assert.equal(h.client.health.errors[0].session, "review");
  h.sessions[1].running = false;
  assert.deepEqual(await h.client.listAttention(), []);
});

test("Herdr service goes offline after two total failures, retains rows, and recovers", async () => {
  const h = harness();
  const store = new Store();
  const service = new HerdrService({ client: h.client, store });
  await service.poll();
  h.data.set("default", new Error("down"));
  h.data.set("review", new Error("down"));
  await service.poll();
  assert.equal(store.getState().herdrOffline, false);
  await service.poll();
  assert.equal(store.getState().herdrOffline, true);
  assert.equal(store.getState().items.length, 2);
  h.data.set("default", snap([agent()]));
  await service.poll();
  assert.equal(store.getState().herdrOffline, false);
});

test("Herdr removes a stopped session even when all remaining reads fail", async () => {
  const h = harness();
  const store = new Store();
  const service = new HerdrService({ client: h.client, store });
  await service.poll();
  h.sessions[1].running = false;
  h.data.set("default", new Error("down"));
  await service.poll();
  assert.equal(store.getState().items.length, 1);
  assert.equal(store.getState().items[0].herdr?.session, "default");
});

test("Herdr no running targets clears keys and reports offline", async () => {
  const h = harness();
  const store = new Store();
  const service = new HerdrService({ client: h.client, store });
  await service.poll();
  h.sessions.forEach(s => { s.running = false; });
  await service.poll();
  assert.deepEqual(store.getState().items, []);
  assert.equal(store.getState().herdrOffline, true);
  assert.equal(await h.client.reachable(), false);
});

test("Herdr rejects malformed snapshots rather than replacing last-good with empty", async () => {
  for (const bad of ["not JSON", "{}", JSON.stringify({ error: { code: "not_found" } }), JSON.stringify({ result: { type: "session_snapshot", snapshot: { workspaces: [], agents: [{}] } } })]) {
    const h = harness({ sessions: ["default"] });
    await h.client.listAttention();
    h.data.set("default", bad);
    await assert.rejects(h.client.listAttention());
    assert.equal(h.client.lastGoodItems.length, 1);
  }
});

test("Herdr discovery failures do not claim known sessions have stopped", async () => {
  const h = harness();
  await h.client.listAttention();
  h.failDiscovery();
  assert.equal((await h.client.listAttention()).length, 2);
  assert.match(h.client.health.errors[0].session, /discovery/);
});

test("Herdr focus re-resolves current pane after movement and refuses disappeared agents", async () => {
  const h = harness({ sessions: ["default"] });
  const [row] = await h.client.listAttention();
  h.data.set("default", snap([agent({ pane_id: "w2:p7", workspace_id: "w2" })]));
  await h.client.focus(row);
  assert.deepEqual(h.calls.at(-1), ["--session", "default", "agent", "focus", "w2:p7"]);
  h.data.set("default", snap([agent({ terminal_id: "replacement" })]));
  const count = h.calls.filter(c => c.includes("focus")).length;
  await assert.rejects(h.client.focus(row), /no longer an agent/);
  assert.equal(h.calls.filter(c => c.includes("focus")).length, count);
});

test("Herdr 0.9.0 focus acknowledges selected completion without hiding a sibling", async () => {
  const h = harness({ sessions: ["default"] });
  const first = agent({ agent_status: "done" });
  const second = agent({ terminal_id: "term_2", pane_id: "w1:p2", agent_status: "done" });
  h.data.set("default", snap([first, second]));
  const rows = await h.client.listAttention();
  await h.client.focus(rows[0]);
  // Real CLI focus marks every pane in the target tab seen.
  h.data.set("default", snap([{ ...first, agent_status: "idle" }, { ...second, agent_status: "idle" }]));
  const after = await h.client.listAttention();
  assert.equal(after.length, 1);
  assert.equal(after[0].herdr?.terminalId, "term_2");
  assert.equal(after[0].reason, "finished");
});

test("Herdr failed focus never acknowledges a completion", async () => {
  const h = harness({ sessions: ["default"] });
  h.data.set("default", snap([agent({ agent_status: "done" })]));
  const [row] = await h.client.listAttention();
  h.failFocus();
  await assert.rejects(h.client.focus(row), /gone/);
  assert.equal((await h.client.listAttention()).length, 1);
});

test("Herdr old servers project the refreshed tab before selecting its stable terminal", async () => {
  const h = harness({ sessions: ["default"] });
  const [row] = await h.client.listAttention();
  h.data.set("default", snap([agent({ workspace_id: "w3", tab_id: "w3:t4", pane_id: "w3:p9" })]));
  await h.client.focus(row);
  assert.deepEqual(h.calls.slice(-2), [["--session", "default", "tab", "focus", "w3:t4"], ["--session", "default", "agent", "focus", "w3:p9"]]);
});

test("Herdr newer servers use their native agent focus projection", async () => {
  const h = harness({ sessions: ["default"] });
  h.data.set("default", { ...snap([agent()]), version: "0.9.3" });
  const [row] = await h.client.listAttention();
  await h.client.focus(row);
  assert.equal(h.calls.some(c => c.includes("tab") && c.includes("focus")), false);
  assert.deepEqual(h.calls.at(-1), ["--session", "default", "agent", "focus", "w1:p1"]);
});

test("Herdr failed or mismatched legacy tab focus preserves completion and never sends agent focus", async () => {
  for (const failure of ["transport", "tab", "workspace"]) {
    const h = harness({ sessions: ["default"] });
    h.data.set("default", snap([agent({ agent_status: "done" })]));
    const runner: CommandRunner = async (bin, args) => {
      if (args.includes("tab") && args.includes("focus")) {
        if (failure === "transport") throw new Error("tab projection failed");
        return { stdout: JSON.stringify({ result: { type: "tab_info", tab: { tab_id: failure === "tab" ? "wrong" : "w1:t1", workspace_id: failure === "workspace" ? "wrong" : "w1" } } }), stderr: "" };
      }
      return h.runner(bin, args);
    };
    const client = new HerdrClient({ runner, includeMachines: false, sessions: ["default"] });
    const [row] = await client.listAttention();
    await assert.rejects(client.focus(row), /tab projection failed|unexpected focused tab/);
    assert.equal(h.calls.some(c => c.includes("agent") && c.includes("focus")), false);
    assert.equal((await client.listAttention())[0].reason, "finished");
  }
});

test("Herdr completion_seq retains unread completions, ack and later observed work", async () => {
  const h = harness({ sessions: ["default"] });
  h.data.set("default", snap([agent({ agent_status: "done", completion_seq: 7 })]));
  const [row] = await h.client.listAttention();
  assert.equal(row.reason, "finished");
  await h.client.focus(row);
  assert.deepEqual(await h.client.listAttention(), []);
  h.data.set("default", snap([agent({ agent_status: "working", state_change_seq: 8 })]));
  assert.equal((await h.client.listAttention())[0].activity, "working");
  h.data.set("default", snap([agent({ agent_status: "idle", state_change_seq: 9, completion_seq: 9 })]));
  assert.equal((await h.client.listAttention())[0].reason, "finished");
});

test("Herdr agent native session replacement cannot inherit pending completion or old age", async () => {
  const h = harness({ sessions: ["default"] });
  h.data.set("default", snap([agent({ agent_status: "done", agent_session: { kind: "id", value: "old" } })]));
  await h.client.listAttention();
  h.data.set("default", snap([agent({ agent_status: "idle", agent_session: { kind: "id", value: "new" } })]));
  assert.deepEqual(await h.client.listAttention(), []);
});

test("Herdr saved machines have namespaced rows and slower noninteractive polling", async () => {
  const h = harness({ remote: true });
  let rows = await h.client.listAttention();
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map(r => r.entityKey)).size, 3);
  const remote = rows.find(r => r.herdr?.machineId === "m1")!;
  assert.match(remote.repo!, /^server\/default/);
  const reads = () => h.calls.filter(c => c[0] === "--machine" && c.includes("snapshot")).length;
  assert.equal(reads(), 1);
  h.setNow(NOW + 14_000);
  rows = await h.client.listAttention();
  assert.equal(reads(), 1);
  assert.equal(rows.length, 3);
  h.setNow(NOW + 15_000);
  await h.client.listAttention();
  assert.equal(reads(), 2);
  await h.client.focus(remote);
  assert.deepEqual(h.calls.at(-1), ["--machine", "m1", "agent", "focus", "w1:p1"]);
});

test("Herdr machine allowlist accepts labels and disabled machines are removed", async () => {
  const h = harness({ remote: true, machines: ["server"] });
  await h.client.listAttention();
  h.machines[0].enabled = false;
  assert.equal((await h.client.listAttention()).length, 2);
  h.machines[0].enabled = true;
  const denied = harness({ remote: true, machines: ["other"] });
  assert.equal((await denied.client.listAttention()).length, 2);
});

test("Herdr remote failures preserve rows, do not fall back to local, and back off", async () => {
  const h = harness({ remote: true });
  await h.client.listAttention();
  h.setNow(NOW + 15_000);
  h.data.set("m1", new Error("SSH authentication required"));
  assert.equal((await h.client.listAttention()).length, 3);
  const reads = h.calls.filter(c => c[0] === "--machine" && c.includes("snapshot")).length;
  h.setNow(NOW + 16_000);
  await h.client.listAttention();
  assert.equal(h.calls.filter(c => c[0] === "--machine" && c.includes("snapshot")).length, reads);
  assert.equal(h.client.health.errors[0].session, "server/default");
});

test("Herdr blocked questions use generic needs-input rendering instead of permission", async () => {
  const h = harness({ sessions: ["review"] });
  const [row] = await h.client.listAttention();
  assert.equal(row.reason, "waiting");
  assert.equal(row.needsInput, true);
});

test("Herdr counter regression resets historical age and completion acknowledgments", async () => {
  const h = harness({ sessions: ["default"] });
  await h.client.listAttention();
  h.setNow(NOW + 1000);
  h.data.set("default", snap([agent({ agent_status: "done", state_change_seq: 8 })]));
  const [old] = await h.client.listAttention();
  await h.client.focus(old);
  h.data.set("default", snap([agent({ agent_status: "done", state_change_seq: 1 })]));
  const [fresh] = await h.client.listAttention();
  assert.equal(fresh.ageUnknown, true);
  assert.equal(fresh.activitySince, undefined);
  assert.equal(fresh.reason, "finished");
});

test("Herdr re-enabled machine bypasses previous cadence and force refresh rereads SSH", async () => {
  const h = harness({ remote: true });
  await h.client.listAttention();
  h.machines[0].enabled = false;
  await h.client.listAttention();
  h.machines[0].enabled = true;
  assert.equal((await h.client.listAttention()).length, 3);
  const reads = () => h.calls.filter(c => c[0] === "--machine" && c.includes("snapshot")).length;
  assert.equal(reads(), 2);
  const service = new HerdrService({ client: h.client, store: new Store() });
  await service.refresh();
  assert.equal(reads(), 3);
});

test("Herdr legacy forwarding falls back only to the saved SSH machine and caches route", async () => {
  const h = harness({ remote: true, legacy: true });
  const remote = (await h.client.listAttention()).find(r => r.herdr?.machineId)!;
  assert.equal(h.sshCalls.length, 1);
  assert.deepEqual(h.sshCalls[0].slice(0, -1), ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", "user@server.example"]);
  assert.match(h.sshCalls[0].at(-1)!, /'--session' 'default' 'api' 'snapshot'$/);
  assert.match(h.sshCalls[0].at(-1)!, /\.local\/bin\/herdr/);
  h.setNow(NOW + 15_000);
  await h.client.listAttention();
  assert.equal(h.calls.filter(c => c[0] === "--machine").length, 1);
  await h.client.focus(remote);
  assert.match(h.sshCalls.at(-1)!.at(-1)!, /'--session' 'default' 'agent' 'focus' 'w1:p1'$/);
});

test("Herdr authentication and transport failures never trigger compatibility fallback", async () => {
  const h = harness({ remote: true });
  h.data.set("m1", new Error("SSH authentication required"));
  await h.client.listAttention();
  assert.equal(h.sshCalls.length, 0);
  assert.equal(h.client.health.errors[0].session, "server/default");
});

test("Herdr legacy SSH refuses option-looking, missing and multiline saved targets", async () => {
  for (const target of ["-oProxyCommand=bad", "", "host\ncommand", "user host"]) {
    const h = harness({ remote: true, legacy: true, sshTarget: target });
    await h.client.listAttention();
    assert.equal(h.sshCalls.length, 0);
    assert.match(h.client.health.errors[0].message, /invalid saved machine target/);
  }
});

test("Herdr POSIX quoting preserves shell syntax and apostrophes as literal arguments", async () => {
  const tokens = ["default", "name'with'quotes", "$(echo EXPANDED)", "`echo EXPANDED`", "line\nnext", "semi;colon", "", "a b"];
  const command = `printf '%s\\0' ${tokens.map(posixQuote).join(" ")}`;
  const { stdout } = await promisify(execFile)("sh", ["-c", command]);
  assert.deepEqual(stdout.split("\0").slice(0, -1), tokens);
  const h = harness({ remote: true, legacy: true });
  h.machines[0].session = "default'; echo INJECTED; #";
  await h.client.listAttention();
  assert.ok(h.sshCalls[0].at(-1)!.endsWith(`${posixQuote("--session")} ${posixQuote(h.machines[0].session)} 'api' 'snapshot'`));
});

test("Herdr zero completion is idle and completion regression reboots observations", async () => {
  const h = harness({ sessions: ["default"] });
  h.data.set("default", snap([agent({ agent_status: "idle", completion_seq: 0 })]));
  assert.deepEqual(await h.client.listAttention(), []);
  h.data.set("default", snap([agent({ agent_status: "done", completion_seq: 7 })]));
  const [row] = await h.client.listAttention();
  await h.client.focus(row);
  h.data.set("default", snap([agent({ agent_status: "done", completion_seq: 1 })]));
  const [reset] = await h.client.listAttention();
  assert.equal(reset.reason, "finished");
  assert.equal(reset.ageUnknown, true);
});

test("Herdr an in-flight focus cannot acknowledge a newer completion from concurrent poll", async () => {
  const h = harness({ sessions: ["default"] });
  h.data.set("default", snap([agent({ agent_status: "done", completion_seq: 7 })]));
  const [row] = await h.client.listAttention();
  h.setFocusHook(async () => {
    h.data.set("default", snap([agent({ agent_status: "idle", state_change_seq: 9, completion_seq: 9 })]));
    await h.client.listAttention();
  });
  await h.client.focus(row);
  const [newer] = await h.client.listAttention();
  assert.equal(newer.reason, "finished");
});

test("Herdr changed SSH targets discard host-specific cadence, route, age and ack", async () => {
  const h = harness({ remote: true, legacy: true });
  h.data.set("m1", snap([agent({ agent_status: "done", completion_seq: 7 })]));
  const remote = (await h.client.listAttention()).find(r => r.herdr?.machineId)!;
  await h.client.focus(remote);
  assert.equal((await h.client.listAttention()).filter(r => r.herdr?.machineId).length, 0);
  const forwardingCalls = () => h.calls.filter(c => c[0] === "--machine").length;
  assert.equal(forwardingCalls(), 1);
  h.machines[0].target = "other@new-server.example";
  const replacement = (await h.client.listAttention()).find(r => r.herdr?.machineId)!;
  assert.equal(forwardingCalls(), 2); // discover the new server's capability
  assert.equal(h.sshCalls.at(-1)!.at(-2), "other@new-server.example");
  assert.equal(replacement.reason, "finished");
  assert.equal(replacement.ageUnknown, true);
});

test("Herdr removing a failed remote without last-good data also removes its backoff", async () => {
  const h = harness({ remote: true });
  h.data.set("m1", new Error("initial connection failed"));
  assert.equal((await h.client.listAttention()).length, 2);
  h.machines[0].enabled = false;
  await h.client.listAttention();
  h.machines[0].enabled = true;
  h.data.set("m1", snap([agent()]));
  assert.equal((await h.client.listAttention()).length, 3);
});

test("Herdr partial-health logs warn and recover once without marking the whole feed offline", async () => {
  const h = harness({ remote: true });
  const warnings: string[] = [];
  const infos: string[] = [];
  const store = new Store();
  const service = new HerdrService({ client: h.client, store, logger: { warn: s => warnings.push(s), info: s => infos.push(s), error() {} } });
  await service.poll();
  h.setNow(NOW + 15_000);
  h.data.set("m1", new Error("remote temporarily unavailable"));
  await service.poll();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /server\/default/);
  assert.match(warnings[0], /last-good/);
  assert.equal(store.getState().herdrOffline, false);
  assert.equal(store.getState().items.length, 3);
  h.setNow(NOW + 16_000);
  await service.poll();
  assert.equal(warnings.length, 1);
  h.setNow(NOW + 30_000);
  h.data.set("m1", snap([agent()]));
  await service.poll();
  assert.equal(infos.length, 1);
  assert.match(infos[0], /recovered/);
  await service.poll();
  assert.equal(infos.length, 1);
});

test("Herdr resolveFocusTarget refreshes pane movement without focus or acknowledgment", async () => {
  const h = harness({ sessions: ["default"] });
  h.data.set("default", snap([agent({ agent_status: "done" })]));
  const [row] = await h.client.listAttention();
  h.data.set("default", snap([agent({ agent_status: "done", pane_id: "w2:p9", workspace_id: "w2" })]));
  const target = await h.client.resolveFocusTarget(row);
  assert.deepEqual(target, { session: "default", machineId: undefined, sshTarget: undefined, socketPath: "/tmp/default.sock", terminalId: "term_1", paneId: "w2:p9", workspaceLabel: undefined, machineLabel: undefined, serverVersion: "0.9.0", requiresExplicitRoute: undefined });
  assert.equal(h.calls.some(c => c.includes("focus") || c.includes("attach")), false);
  assert.equal((await h.client.listAttention())[0].reason, "finished");
});

test("Herdr resolveFocusTarget pins the saved machine route and refuses missing terminals", async () => {
  const h = harness({ remote: true, legacy: true });
  const row = (await h.client.listAttention()).find(r => r.herdr?.machineId)!;
  h.data.set("m1", snap([agent({ pane_id: "w4:p1" })]));
  const target = await h.client.resolveFocusTarget(row);
  assert.equal(target.machineId, "m1");
  assert.equal(target.sshTarget, "user@server.example");
  assert.equal(target.session, "default");
  assert.equal(target.paneId, "w4:p1");
  assert.equal(h.sshCalls.some(c => c.at(-1)!.includes("'focus'") || c.at(-1)!.includes("'attach'")), false);
  h.data.set("m1", snap([agent({ terminal_id: "replacement" })]));
  await assert.rejects(h.client.resolveFocusTarget(row), /no longer an agent/);
});

test("Herdr focus discovery detects ambiguous same-host routes even outside the allowlist", async () => {
  const h = harness({ remote: true, machines: ["m1"] });
  h.machines.push({ id: "m2", label: "other-user", session: "default", enabled: true, target: "other@server.example" });
  const row = (await h.client.listAttention()).find(r => r.herdr?.machineId)!;
  assert.equal((await h.client.resolveFocusTarget(row)).requiresExplicitRoute, true);
  h.machines[1].enabled = false;
  assert.equal((await h.client.resolveFocusTarget(row)).requiresExplicitRoute, false);
  h.machines[1].enabled = true;
  h.machines[1].target = h.machines[0].target;
  h.machines[1].session = "different-native-session";
  assert.equal((await h.client.resolveFocusTarget(row)).requiresExplicitRoute, true);
});

test("Herdr resolveFocusTarget refuses stopped sessions and invalid saved SSH targets", async () => {
  const local = harness({ sessions: ["default"] });
  const [row] = await local.client.listAttention();
  local.sessions[0].running = false;
  await assert.rejects(local.client.resolveFocusTarget(row), /no longer running/);
  const remote = harness({ remote: true });
  const item = (await remote.client.listAttention()).find(r => r.herdr?.machineId)!;
  remote.machines[0].target = "-oProxyCommand=bad";
  await assert.rejects(remote.client.resolveFocusTarget(item), /invalid saved machine target/);
});

test("Herdr expected focus route rejects profile edits before any focus or acknowledgment", async () => {
  const h = harness({ remote: true, legacy: true });
  h.data.set("m1", snap([agent({ agent_status: "done", completion_seq: 7 })]));
  const item = (await h.client.listAttention()).find(r => r.herdr?.machineId)!;
  const target = await h.client.resolveFocusTarget(item);
  h.machines[0].target = "other@replacement-host.example";
  await assert.rejects(h.client.focus(item, target), /target changed/);
  assert.equal(h.sshCalls.some(c => c.at(-1)!.includes("'focus'")), false);
  assert.equal((await h.client.listAttention()).find(r => r.herdr?.machineId)!.reason, "finished");
});

test("Herdr expected focus route allows terminal pane movement on the same host", async () => {
  const h = harness({ sessions: ["default"] });
  const [item] = await h.client.listAttention();
  const target = await h.client.resolveFocusTarget(item);
  h.data.set("default", snap([agent({ pane_id: "w2:p3", workspace_id: "w2", tab_id: "w2:t1" })]));
  await h.client.focus(item, target);
  assert.deepEqual(h.calls.at(-1), ["--session", "default", "agent", "focus", "w2:p3"]);
});
