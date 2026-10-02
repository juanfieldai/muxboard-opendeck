/**
 * Real Herdr CLI/server integration. Every mutation is explicitly scoped to
 * sessions owned by this run; default/user sessions and saved machines are
 * never controlled. Run with npm run test:herdr:e2e (Herdr >= 0.9.3).
 */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HerdrClient } from "../src/core/herdr/client.js";
import { HerdrService } from "../src/core/services/herdrService.js";
import { Store } from "../src/core/services/store.js";
import { renderKey } from "../src/core/render/keyRender.js";
import type { AttentionItem } from "../src/core/types.js";

const exec = promisify(execFile);
const bin = process.env.HERDR_BIN ?? "herdr";
const prefix = `muxboard-e2e-${Date.now().toString(36)}-${process.pid}`;
const owned = [`${prefix}-a`, `${prefix}-b`];
const workDir = await mkdtemp(join(tmpdir(), "muxboard-herdr-e2e-"));
const configPath = join(workDir, "config.toml");
await writeFile(configPath, "onboarding = false\n[update]\ncheck = false\nmanifest_check = false\n[session]\nresume_agents_on_restore = false\n");
const env = { ...process.env, HERDR_CONFIG_PATH: configPath, SHELL: "/bin/sh" };
for (const key of Object.keys(env)) if (key.startsWith("HERDR_") && key !== "HERDR_CONFIG_PATH") delete env[key];
const servers = new Map<string, ChildProcess>();
const logs = new Map<string, string>();
let checks = 0;
let injectFailure: string | undefined;

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function guard(session: string): void {
  assert.ok(owned.includes(session), `refusing to control unowned session ${session}`);
}
async function run(args: string[]) {
  return exec(bin, args, { env, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
}
async function command(session: string, args: string[]): Promise<any> {
  guard(session);
  const { stdout } = await run(["--session", session, ...args]);
  // Commands such as pane run and server stop acknowledge via exit status.
  if (!stdout.trim()) return {};
  const data = JSON.parse(stdout);
  assert.ok(!data.error, `Herdr ${args.join(" ")}: ${JSON.stringify(data.error)}`);
  return data;
}
async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  const until = Date.now() + 12_000;
  let error: unknown;
  while (Date.now() < until) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch (err) { error = err; }
    await delay(100);
  }
  throw new Error(`timed out: ${label}${error ? ` (${String(error)})` : ""}`);
}
async function start(session: string): Promise<void> {
  guard(session);
  const previous = servers.get(session);
  if (previous && previous.exitCode === null) await eventually(async () => previous.exitCode, code => code !== null, "previous server exit");
  const server = spawn(bin, ["--session", session, "server"], { env, stdio: ["ignore", "pipe", "pipe"] });
  servers.set(session, server);
  logs.set(session, "");
  server.on("error", err => logs.set(session, `${logs.get(session)}\n${String(err)}`));
  for (const stream of [server.stdout, server.stderr]) stream?.on("data", chunk => logs.set(session, `${logs.get(session)}${chunk}`.slice(-20_000)));
  await eventually(() => command(session, ["status", "server", "--json"]), data => data.running === true, `${session} start`);
}
async function snapshot(session: string): Promise<any> {
  return (await command(session, ["api", "snapshot"])).result.snapshot;
}
async function createPane(session: string, label: string): Promise<{ paneId: string; terminalId: string }> {
  const result = await command(session, ["workspace", "create", "--cwd", workDir, "--label", label, "--no-focus"]);
  const workspaceId = result.result.workspace.workspace_id;
  const data = await snapshot(session);
  const pane = data.panes.find((row: any) => row.workspace_id === workspaceId);
  assert.ok(pane, "new workspace has a pane");
  // Keep a foreground process alive so Herdr's shell-return detection does not
  // clear our deliberately self-reported fake agent between assertions.
  await command(session, ["pane", "run", pane.pane_id, "sleep 600"]);
  await delay(250);
  return { paneId: pane.pane_id, terminalId: pane.terminal_id };
}
async function split(session: string, paneId: string): Promise<{ paneId: string; terminalId: string }> {
  const before = await snapshot(session);
  await command(session, ["pane", "split", paneId, "--direction", "right", "--cwd", workDir, "--no-focus"]);
  const after = await snapshot(session);
  const pane = after.panes.find((row: any) => !before.panes.some((old: any) => old.terminal_id === row.terminal_id));
  assert.ok(pane, "split creates a distinct terminal");
  await command(session, ["pane", "run", pane.pane_id, "sleep 600"]);
  await delay(250);
  return { paneId: pane.pane_id, terminalId: pane.terminal_id };
}
async function report(session: string, paneId: string, state: string, agent = "codex", extra: string[] = []): Promise<void> {
  await command(session, ["pane", "report-agent", paneId, "--source", "muxboard-e2e", "--agent", agent, "--state", state, ...extra]);
  await eventually(() => snapshot(session), data => data.agents.some((row: any) => row.pane_id === paneId &&
    (row.agent_status === state || state === "idle" && row.agent_status === "done")), `${paneId} report ${state}`);
}
function check(label: string, verify: () => void): void {
  verify();
  checks++;
  console.log(`ok ${checks} - ${label}`);
}

try {
  const version = (await run(["--version"])).stdout.trim();
  console.log(`Herdr end-to-end: ${version}; owned sessions ${owned.join(", ")}`);
  // Explicit allow-list plus includeMachines:false makes the adapter itself as
  // isolated as the mutation helpers, including when saved profiles exist.
  const runner = async (_bin: string, args: string[]) => {
    if (injectFailure && args.includes(injectFailure) && args.includes("snapshot")) throw new Error("injected E2E snapshot transport failure");
    return run(args);
  };
  const client = new HerdrClient({ bin, sessions: owned, includeMachines: false, runner });
  let now = Date.now();
  const store = new Store([], () => now);
  const service = new HerdrService({ client, store, pollMs: 10_000 });
  const items = () => store.getState().items.filter(item => item.source === "herdr");
  const lookup = (terminalId: string) => items().find(item => item.herdr?.terminalId === terminalId);
  const poll = async () => { await service.poll(); return items(); };
  await start(owned[0]);
  await start(owned[1]);
  const first = await createPane(owned[0], "same-project");
  const sibling = await split(owned[0], first.paneId);
  const other = await createPane(owned[1], "same-project");
  await report(owned[0], first.paneId, "blocked");
  await report(owned[0], sibling.paneId, "working");
  await report(owned[1], other.paneId, "blocked");
  await poll();
  check("multiple panes and named sessions survive queue dedup", () => {
    assert.equal(items().length, 3);
    assert.equal(first.paneId, other.paneId, "fresh servers deliberately reuse pane ids");
    assert.notEqual(lookup(first.terminalId)?.entityKey, lookup(other.terminalId)?.entityKey);
    assert.equal(lookup(first.terminalId)?.workspaceId, lookup(sibling.terminalId)?.workspaceId);
    assert.equal(items().at(-1)?.herdr?.terminalId, sibling.terminalId);
  });
  check("blocked needs input, working is synthetic, and bootstrap age is unknown", () => {
    assert.equal(lookup(first.terminalId)?.needsInput, true);
    assert.equal(lookup(sibling.terminalId)?.synthetic, true);
    assert.equal(lookup(first.terminalId)?.ageUnknown, true);
    assert.doesNotMatch(renderKey(lookup(first.terminalId)!, { nowMs: now }), /NaN/);
  });
  store.cycleView();
  check("decisions view includes both blocked sessions and hides working", () => {
    assert.equal(items().length, 2);
    assert.ok(items().every(item => item.needsInput));
  });
  store.cycleView();
  const target = lookup(first.terminalId)!;
  store.snoozeItem(target, 1_000);
  check("snooze affects only selected terminal", () => {
    assert.equal(lookup(first.terminalId), undefined);
    assert.ok(lookup(sibling.terminalId));
    assert.ok(lookup(other.terminalId));
  });
  now += 1_001;
  await poll();
  check("expired snooze reappears on polling", () => assert.ok(lookup(first.terminalId)));
  await report(owned[0], first.paneId, "working");
  await poll();
  await report(owned[0], first.paneId, "idle");
  await report(owned[0], sibling.paneId, "idle");
  await poll();
  check("working to idle produces unseen completion and observed state age", () => {
    assert.equal(lookup(first.terminalId)?.reason, "finished");
    assert.equal(lookup(sibling.terminalId)?.reason, "finished");
    assert.equal(lookup(first.terminalId)?.ageUnknown, false);
  });
  await client.focus(lookup(first.terminalId)!);
  await poll();
  check("focus acknowledges only selected completion despite tab-wide seen status", () => {
    assert.equal(lookup(first.terminalId), undefined);
    assert.equal(lookup(sibling.terminalId)?.reason, "finished");
  });
  await client.focus(lookup(sibling.terminalId)!);
  await poll();
  check("native idle after viewing is absent from queue", () => assert.equal(lookup(sibling.terminalId), undefined));
  await report(owned[0], sibling.paneId, "working");
  await poll();
  await report(owned[0], sibling.paneId, "idle");
  await poll();
  check("a later completed turn reappears after acknowledging its predecessor", () => {
    assert.equal(lookup(sibling.terminalId)?.reason, "finished");
  });
  await report(owned[0], sibling.paneId, "blocked");
  // Native references are accepted only from the official integration source.
  // This simulates its report in our owned pane; restore is disabled in config.
  await command(owned[0], ["pane", "report-agent-session", sibling.paneId, "--source", "herdr:codex", "--agent", "codex", "--agent-session-id", "muxboard-e2e-native-session"]);
  await poll();
  const native = await snapshot(owned[0]);
  check("native conversation reference is read without resuming or hiding live pane", () => {
    assert.equal(native.agents.find((row: any) => row.terminal_id === sibling.terminalId).agent_session?.value, "muxboard-e2e-native-session");
    assert.equal(lookup(sibling.terminalId)?.needsInput, true);
  });
  const unclassified = await createPane(owned[0], "unclassified");
  await report(owned[0], unclassified.paneId, "unknown", "muxboard-test-agent");
  await poll();
  check("unknown agent/state is neutral and never a completion", () => {
    assert.equal(lookup(unclassified.terminalId)?.agent, "unknown");
    assert.equal(lookup(unclassified.terminalId)?.reason, "unknown");
  });
  await report(owned[0], first.paneId, "blocked");
  await poll();
  const staleTarget = lookup(first.terminalId)!;
  const moved = await command(owned[0], ["pane", "move", first.paneId, "--new-workspace", "--label", "moved", "--no-focus"]);
  const movedPane = moved.result.move_result.pane.pane_id;
  await client.focus(staleTarget);
  const movedSnapshot = await snapshot(owned[0]);
  check("focus resolves stable terminal identity after pane move", () => {
    assert.notEqual(movedPane, first.paneId);
    assert.ok(movedSnapshot.agents.some((row: any) => row.terminal_id === first.terminalId && row.pane_id === movedPane && row.focused));
  });
  injectFailure = owned[0];
  await report(owned[1], other.paneId, "working");
  await poll();
  check("one snapshot failure retains that session while another updates", () => {
    assert.ok(lookup(first.terminalId));
    assert.equal(lookup(other.terminalId)?.activity, "working");
    assert.equal(client.health.errors.length, 1);
  });
  injectFailure = undefined;
  await poll();
  check("snapshot recovery clears partial-session errors", () => assert.equal(client.health.errors.length, 0));
  await command(owned[0], ["server", "stop"]);
  await eventually(() => poll(), rows => !rows.some(row => row.herdr?.session === owned[0]), "stopped session removed");
  check("stopping one owned session removes only its keys", () => {
    assert.equal(items().length, 1);
    assert.equal(items()[0].herdr?.session, owned[1]);
  });
  await start(owned[0]);
  const restored = await createPane(owned[0], "recovered");
  await report(owned[0], restored.paneId, "blocked");
  await poll();
  check("restarted named session is discovered without replacing healthy slice", () => {
    assert.ok(lookup(restored.terminalId));
    assert.ok(lookup(other.terminalId));
  });
  await command(owned[0], ["pane", "close", restored.paneId]);
  await poll();
  check("closed terminal disappears on next snapshot", () => assert.equal(lookup(restored.terminalId), undefined));
  const closedItem: AttentionItem = { ...target, herdr: { ...target.herdr!, terminalId: restored.terminalId, paneId: restored.paneId } };
  await assert.rejects(() => client.focus(closedItem));
  check("focus of closed terminal fails without selecting another agent", () => assert.ok(lookup(other.terminalId)));
  for (const session of owned) await command(session, ["server", "stop"]);
  await eventually(() => poll(), rows => rows.length === 0, "all owned sessions stopped");
  check("stopped sessions clear the Herdr queue and mark the source unavailable", () => {
    assert.equal(items().length, 0);
    assert.equal(store.getState().herdrOffline, true);
  });
  console.log(`Passed ${checks} real CLI/server checks.`);
} catch (err) {
  for (const [session, log] of logs) if (log.trim()) console.error(`Server log ${session}:\n${log}`);
  throw err;
} finally {
  for (const session of owned) {
    guard(session);
    try { await command(session, ["server", "stop"]); } catch { /* Already stopped or never started. */ }
    const server = servers.get(session);
    if (server && server.exitCode === null) {
      try { await eventually(async () => server.exitCode, code => code !== null, `${session} cleanup exit`); }
      catch { server.kill("SIGTERM"); await delay(100); }
    }
    try { await run(["session", "delete", session, "--json"]); }
    catch (err) { console.error(`Cleanup could not delete owned session ${session}: ${String(err)}`); }
  }
  const remaining = JSON.parse((await run(["session", "list", "--json"])).stdout).sessions;
  assert.ok(!remaining.some((session: any) => owned.includes(session.name)), "cleanup removed every owned session");
  await rm(workDir, { recursive: true, force: true });
}
