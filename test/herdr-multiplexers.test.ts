import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverMultiplexerHost, sameMultiplexerId, type MultiplexerHostOptions } from "../src/core/herdr/multiplexers.js";

const target = { session: "default", socketPath: "/tmp/herdr.sock", terminalId: "t1", paneId: "p1" };
const W = "11111111-1111-1111-1111-111111111111";
const S = "22222222-2222-2222-2222-222222222222";
const WIN = "33333333-3333-3333-3333-333333333333";
const APP = "/Applications/Novel Terminal.app/Contents/MacOS/Novel Terminal";

function tmuxFixture() {
  const calls: { bin: string; args: string[] }[] = [];
  let panes = "$1\t@2\t%3\t/dev/ttys004\tremote: project\n";
  let clients = "80\t/dev/ttys000\t$1\t%9\tshell title\t0\n";
  let titles = ["tmux - shell title"];
  let app: { pid: number; comm: string } | undefined = { pid: 70, comm: APP };
  const opts: MultiplexerHostOptions = { target, herdrPid: 99, tty: "ttys004", env: { TMUX: "/tmp/owned.sock,10,1", TMUX_PANE: "%3" },
    appAncestor: pid => pid === 80 ? app : undefined,
    matchesEndpoint: title => title === "remote: project",
    runner: async (bin, args) => {
      calls.push({ bin, args });
      if (args.includes("list-panes")) return { stdout: panes, stderr: "" };
      if (args.includes("list-clients")) return { stdout: clients, stderr: "" };
      if (bin === "osascript") return { stdout: JSON.stringify(titles), stderr: "" };
      throw new Error("unexpected operation");
    } };
  return { opts, calls, panes: (v: string) => { panes = v; }, clients: (v: string) => { clients = v; }, titles: (v: string[]) => { titles = v; }, app: (v: typeof app) => { app = v; } };
}

test("tmux discovery proves exact pane tty/endpoint and unique attached GUI client", async () => {
  const f = tmuxFixture();
  const host = await discoverMultiplexerHost(f.opts);
  assert.deepEqual(host, { herdrPid: 99, tty: "ttys004", appPid: 70, appExecutable: APP,
    tmux: { socket: "/tmp/owned.sock", paneId: "%3", sessionId: "$1", windowId: "@2", clientTty: "/dev/ttys000", clientPid: 80 },
    windowHint: { title: "tmux - shell title" } });
  assert.ok(f.calls.filter(c => c.bin === "tmux").every(c => c.args[0] === "-N" && c.args[1] === "-S" && c.args[2] === "/tmp/owned.sock"));
  assert.equal(f.calls.some(c => c.args.includes("switch-client") || c.args.includes("attach-session")), false);
});

test("tmux discovery rejects stale pane env and wrong endpoint", async () => {
  const f = tmuxFixture();
  f.panes("$1\t@2\t%3\t/dev/ttys099\tremote: project\n");
  assert.equal(await discoverMultiplexerHost(f.opts), undefined);
  f.panes("$1\t@2\t%3\t/dev/ttys004\tother: project\n");
  assert.equal(await discoverMultiplexerHost(f.opts), undefined);
});

test("tmux rejects duplicate clients, detached sessions, and control clients", async () => {
  const f = tmuxFixture();
  f.clients("80\t/dev/ttys000\t$1\t%9\tshell title\t0\n81\t/dev/ttys001\t$1\t%9\tshell title\t0\n");
  assert.equal(await discoverMultiplexerHost(f.opts), undefined);
  f.clients("80\t/dev/ttys000\t$8\t%9\tshell title\t0\n");
  assert.equal(await discoverMultiplexerHost(f.opts), undefined);
  f.clients("80\t/dev/ttys000\t$1\t%9\tshell title\t1\n");
  assert.equal(await discoverMultiplexerHost(f.opts), undefined);
});

test("tmux requires a GUI ancestor and positive unique native window title", async () => {
  const f = tmuxFixture();
  f.app(undefined);
  assert.equal(await discoverMultiplexerHost(f.opts), undefined);
  f.app({ pid: 70, comm: APP });
  f.titles(["unrelated"]);
  assert.equal(await discoverMultiplexerHost(f.opts), undefined);
  f.titles(["shell title one", "shell title two"]);
  assert.equal(await discoverMultiplexerHost(f.opts), undefined);
});

test("tmux rejects malformed routing and ambiguous duplicate panes without mutation", async () => {
  const f = tmuxFixture();
  f.opts.env.TMUX = "relative.sock,10,1";
  assert.equal(await discoverMultiplexerHost(f.opts), undefined);
  assert.equal(f.calls.length, 0);
  f.opts.env.TMUX = "/tmp/owned.sock,10,1";
  f.panes("$1\t@2\t%3\t/dev/ttys004\tremote: project\n$1\t@2\t%3\t/dev/ttys004\tremote: project\n");
  assert.equal(await discoverMultiplexerHost(f.opts), undefined);
});

function cmuxFixture() {
  const calls: { bin: string; args: string[] }[] = [];
  let socket = "/tmp/cmux-owned.sock", executable = APP;
  let tree: unknown = { windows: [{ id: WIN, workspaces: [{ id: W, panes: [{ surfaces: [{ id: S, type: "terminal", title: "remote: project" }] }] }] }] };
  let top: unknown = { windows: [{ workspaces: [{ id: W, panes: [{ surfaces: [{ id: S, processes: [{ pid: 88, children: [{ pid: 99 }] }] }] }] }] }] };
  let app: { pid: number; comm: string } | undefined = { pid: 70, comm: APP };
  const opts: MultiplexerHostOptions = { target, herdrPid: 99, tty: "ttys004", env: { CMUX_SOCKET_PATH: socket, CMUX_WORKSPACE_ID: W, CMUX_SURFACE_ID: S },
    appAncestor: pid => pid === 99 ? app : undefined,
    matchesEndpoint: title => title === "remote: project",
    runner: async (bin, args) => {
      calls.push({ bin, args });
      const data = args.includes("identify") ? { socket_path: socket, app_executable_path: executable } : args.includes("tree") ? tree : args.includes("top") ? top : undefined;
      if (!data) throw new Error("unexpected operation");
      return { stdout: JSON.stringify(data), stderr: "" };
    } };
  return { opts, calls, tree: (v: unknown) => { tree = v; }, top: (v: unknown) => { top = v; }, app: (v: typeof app) => { app = v; }, socket: (v: string) => { socket = v; }, executable: (v: string) => { executable = v; } };
}

test("cmux discovery proves UUID ownership, process membership, endpoint and owning GUI", async () => {
  const f = cmuxFixture();
  assert.deepEqual(await discoverMultiplexerHost(f.opts), { herdrPid: 99, tty: "ttys004", appPid: 70, appExecutable: APP,
    cmux: { workspaceId: W, surfaceId: S, windowId: WIN, socketPath: "/tmp/cmux-owned.sock" } });
  assert.ok(f.calls.every(c => c.args[0] === "--socket" && c.args[1] === "/tmp/cmux-owned.sock"));
  assert.ok(f.calls.filter(c => !c.args.includes("identify")).every(c => c.args.includes("--id-format") && c.args.includes("both")));
  assert.equal(f.calls.some(c => c.args.includes("rpc") || c.args.includes("focus-window")), false);
});

test("cmux default socket lookup is validated then pinned for every query", async () => {
  const f = cmuxFixture();
  delete f.opts.env.CMUX_SOCKET_PATH;
  assert.ok(await discoverMultiplexerHost(f.opts));
  assert.deepEqual(f.calls[0].args, ["--json", "identify", "--no-caller"]);
  assert.ok(f.calls.slice(1).every(c => c.args[0] === "--socket" && c.args[1] === "/tmp/cmux-owned.sock"));
});

test("cmux queries the background target explicitly despite another caller workspace", async () => {
  const f = cmuxFixture();
  const targetRunner = f.opts.runner;
  f.opts.runner = async (bin, args) => {
    if (args.includes("tree") || args.includes("top")) {
      // Model a CLI launched from another cmux workspace: an unqualified query
      // returns caller state, while an explicit target also has selected=false.
      if (args[args.indexOf("--workspace") + 1] !== W) {
        return { stdout: JSON.stringify({ windows: [] }), stderr: "" };
      }
    }
    return targetRunner(bin, args);
  };
  f.tree({ windows: [{ id: WIN, current: false, workspaces: [{ id: W, selected: false, panes: [{ surfaces: [{ id: S, type: "terminal", title: "remote: project", focused: false }] }] }] }] });
  assert.ok(await discoverMultiplexerHost(f.opts));
  for (const call of f.calls.filter(c => c.args.includes("tree") || c.args.includes("top"))) {
    assert.equal(call.args[call.args.indexOf("--workspace") + 1], W);
    assert.ok(call.args.includes("--all"));
  }
});

test("cmux rejects stale process membership and wrong workspace despite matching surface", async () => {
  const f = cmuxFixture();
  f.top({ windows: [{ workspaces: [{ id: W, panes: [{ surfaces: [{ id: S, processes: [{ pid: 98 }] }] }] }] }] });
  assert.equal(await discoverMultiplexerHost(f.opts), undefined);
  f.top({ windows: [{ workspaces: [{ id: WIN, panes: [{ surfaces: [{ id: S, processes: [{ pid: 99 }] }] }] }] }] });
  assert.equal(await discoverMultiplexerHost(f.opts), undefined);
});

test("cmux accepts direct top process arrays and case-insensitive UUID identity", async () => {
  const f = cmuxFixture();
  f.top({ windows: [{ workspaces: [{ id: W, panes: [{ surfaces: [{ id: S, tty_process_pids: [99] }] }] }] }] });
  assert.ok(await discoverMultiplexerHost(f.opts));
  assert.equal(sameMultiplexerId("AABB", "aabb"), true);
  assert.equal(sameMultiplexerId(undefined, undefined), false);
});

test("cmux rejects duplicate surface membership, nonterminal and wrong endpoint", async () => {
  const f = cmuxFixture();
  for (const surfaces of [
    [{ id: S, type: "terminal", title: "remote: project" }, { id: S, type: "terminal", title: "remote: project" }],
    [{ id: S, type: "browser", title: "remote: project" }],
    [{ id: S, type: "terminal", title: "wrong: project" }],
  ]) {
    f.tree({ windows: [{ id: WIN, workspaces: [{ id: W, panes: [{ surfaces }] }] }] });
    assert.equal(await discoverMultiplexerHost(f.opts), undefined);
  }
});

test("cmux rejects changed socket or app executable and invalid UUIDs", async () => {
  const f = cmuxFixture();
  f.socket("/tmp/unrelated.sock");
  assert.equal(await discoverMultiplexerHost(f.opts), undefined);
  f.socket("/tmp/cmux-owned.sock"); f.executable("/Applications/Wrong.app/Contents/MacOS/Wrong");
  assert.equal(await discoverMultiplexerHost(f.opts), undefined);
  f.opts.env.CMUX_SURFACE_ID = "surface:1";
  assert.equal(await discoverMultiplexerHost(f.opts), undefined);
});

test("multiplexer discovery fails closed on unavailable CLI and nested muxes", async () => {
  const f = tmuxFixture();
  f.opts.runner = async () => { throw new Error("unavailable"); };
  assert.equal(await discoverMultiplexerHost(f.opts), undefined);
  f.opts.env.CMUX_SURFACE_ID = S;
  assert.equal(await discoverMultiplexerHost(f.opts), undefined);
  delete f.opts.env.CMUX_SURFACE_ID; f.opts.env.ZELLIJ_SESSION_NAME = "nested";
  assert.equal(await discoverMultiplexerHost(f.opts), undefined);
});
