import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverHerdrHost, parseHostEnvironment } from "../src/core/herdr/hosts.js";
import type { HerdrFocusTarget } from "../src/core/herdr/client.js";
import type { CommandRunner } from "../src/core/exec.js";

const target: HerdrFocusTarget = { session: "default", machineId: "m1", sshTarget: "user@spark-bc66", workspaceLabel: "project", socketPath: "remote:m1", terminalId: "term1", paneId: "w1:p1" };
function fixture() {
  const calls: Array<{ bin: string; args: string[] }> = [];
  let processes = "700 1 ?? /Applications/Novel Terminal.app/Contents/MacOS/Novel Terminal\n890 700 ttys000 /bin/zsh\n59130 890 ttys000 zellij\n34420 1 ?? /opt/homebrew/bin/zellij\n34421 34420 ttys044 /bin/zsh\n25563 34421 ttys044 herdr\n81640 34421 ttys063 herdr\n90744 1 ?? herdr\n";
  const args = new Map([[25563, "herdr"], [81640, "herdr"], [90744, "herdr server"], [59130, "zellij a"]]);
  const env = new Map([[25563, "herdr ZELLIJ_SESSION_NAME=mellifluous-orange ZELLIJ_PANE_ID=0 ALACRITTY_SOCKET=/tmp/Alacritty-700.sock ALACRITTY_WINDOW_ID=123 PRIVATE_TOKEN=never-expose-this"], [81640, "herdr ZELLIJ_SESSION_NAME=mellifluous-orange ZELLIJ_PANE_ID=3"], [90744, "herdr server PRIVATE_TOKEN=never-expose-this"]]);
  let panes: unknown = [{ id: 0, is_plugin: true, title: "spark-bc66: plugin" }, { id: 0, is_plugin: false, title: "spark-bc66: project" }, { id: 3, is_plugin: false, title: "different-machine: project" }];
  let clients = "CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n1 terminal_3 herdr\n";
  let titles: string[] = ["spark-bc66: project"];
  let pids = "25563\n81640\n90744\n";
  let remoteHostname = "";
  const runner: CommandRunner = async (bin, command) => {
    calls.push({ bin, args: command });
    let stdout = "";
    if (bin === "pgrep") stdout = pids;
    else if (bin === "ps" && command.includes("-axo")) stdout = processes;
    else if (bin === "ps") {
      const pid = Number(command[command.indexOf("-p") + 1]);
      stdout = command.includes("eww") ? env.get(pid) ?? "" : args.get(pid) ?? "";
    } else if (command.includes("list-panes")) stdout = JSON.stringify(panes);
    else if (command.includes("list-clients")) stdout = clients;
    else if (bin === "osascript") stdout = JSON.stringify(titles);
    else if (bin === "ssh") stdout = remoteHostname;
    else throw new Error("unexpected discovery command");
    return { stdout, stderr: "" };
  };
  return { runner, calls, args, env, setProcesses: (s: string) => { processes = s; }, addProcess: (s: string) => { processes += s; }, setPanes: (p: unknown) => { panes = p; }, setClients: (s: string) => { clients = s; }, setTitles: (s: string[]) => { titles = s; }, setPids: (s: string) => { pids = s; }, setRemoteHostname: (s: string) => { remoteHostname = s; } };
}

test("Herdr host discovery finds detached Zellij client and dynamic GUI ancestor", async () => {
  const f = fixture();
  const host = await discoverHerdrHost(target, { runner: f.runner });
  assert.equal(host.herdrPid, 25563);
  assert.equal(host.appPid, 700);
  assert.match(host.appExecutable, /Novel Terminal/);
  assert.deepEqual(host.zellij, { session: "mellifluous-orange", paneId: "terminal_0", attachedClientsCount: 1, clientId: 1, frontendPid: 59130 });
  assert.equal(host.windowHint?.alacrittyWindowId, "123");
  assert.doesNotMatch(JSON.stringify(host), /PRIVATE_TOKEN|never-expose/);
  assert.ok(f.calls.filter(c => c.bin === "ps" && !c.args.includes("eww")).every(c => c.args.includes("-ww")));
  assert.deepEqual(f.calls.find(c => c.bin === "ps" && c.args.includes("eww"))!.args, ["eww", "-p", "25563", "-o", "command="]);
  assert.equal(f.calls.filter(c => c.args.includes("list-panes")).length, 1);
  assert.equal(f.calls.filter(c => c.args.includes("list-clients")).length, 1);
  assert.equal(f.calls.some(c => c.args.some(a => ["focus-pane-id", "attach", "write-chars"].includes(a))), false);
});

test("Herdr host environment parser returns only routing whitelist", () => {
  assert.deepEqual(parseHostEnvironment("herdr SECRET=unsafe TMUX=/tmp/tmux,10,0 TMUX_PANE=%1 CMUX_WORKSPACE_ID=w CMUX_SURFACE_ID=s CMUX_SOCKET_PATH=/tmp/cmux.sock TERM_PROGRAM=Example RANDOM=private"), { TMUX: "/tmp/tmux,10,0", TMUX_PANE: "%1", CMUX_WORKSPACE_ID: "w", CMUX_SURFACE_ID: "s", CMUX_SOCKET_PATH: "/tmp/cmux.sock", TERM_PROGRAM: "Example" });
});

test("Herdr host discovery rejects wrong selected machine even with the same workspace", async () => {
  const f = fixture();
  await assert.rejects(discoverHerdrHost({ ...target, sshTarget: "arbor.example" }, { runner: f.runner }), /No unambiguous/);
});

test("Herdr host discovery rejects duplicate matching Herdr views", async () => {
  const f = fixture();
  f.setPanes([{ id: 0, title: "spark-bc66: project" }, { id: 3, title: "spark-bc66: project" }]);
  await assert.rejects(discoverHerdrHost(target, { runner: f.runner }), /Multiple existing/);
});

test("Herdr remote host discovery prefers the selected workspace and supports other workspace focus", async () => {
  const f = fixture();
  f.setPanes([{ id: 0, title: "spark-bc66: other-project" }, { id: 3, title: "spark-bc66: project" }]);
  assert.equal((await discoverHerdrHost({ ...target, serverVersion: "0.9.0" }, { runner: f.runner })).herdrPid, 81640);
  f.setPanes([{ id: 0, title: "spark-bc66: other-project" }]);
  assert.equal((await discoverHerdrHost({ ...target, serverVersion: "0.9.0" }, { runner: f.runner })).herdrPid, 25563);
  assert.equal(f.calls.some(c => c.bin === "ssh"), false);
});

test("Herdr SSH aliases resolve canonical displayed hostname with bounded read-only argv", async () => {
  const f = fixture();
  f.setPanes([{ id: 0, title: "g400-237n5: project" }, { id: 3, title: "different-machine: project" }]);
  f.setRemoteHostname("g400-237n5\n");
  const host = await discoverHerdrHost({ ...target, sshTarget: "user@arbor.naiveneuron.com" }, { runner: f.runner });
  assert.equal(host.herdrPid, 25563);
  assert.deepEqual(f.calls.find(c => c.bin === "ssh")!.args, ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", "user@arbor.naiveneuron.com", "hostname"]);
  assert.equal(f.calls.filter(c => c.args.includes("list-panes")).length, 1);
});

test("Herdr SSH alias discovery never runs unsafe destinations or accepts malformed hostname output", async () => {
  const f = fixture();
  f.setRemoteHostname("g400-237n5\nunsafe extra");
  await assert.rejects(discoverHerdrHost({ ...target, sshTarget: "arbor.example" }, { runner: f.runner }), /No unambiguous/);
  f.calls.length = 0;
  await assert.rejects(discoverHerdrHost({ ...target, sshTarget: "-oProxyCommand=anything" }, { runner: f.runner }), /No unambiguous/);
  assert.equal(f.calls.some(c => c.bin === "ssh"), false);
});

test("Herdr matching SSH hostname skips alias discovery", async () => {
  const f = fixture();
  await discoverHerdrHost(target, { runner: f.runner });
  assert.equal(f.calls.some(c => c.bin === "ssh"), false);
});

test("Herdr host discovery rejects multiple attached Zellij clients", async () => {
  const f = fixture();
  f.setClients("CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n1 terminal_0 herdr\n2 terminal_3 herdr\n");
  await assert.rejects(discoverHerdrHost(target, { runner: f.runner }), /No unambiguous/);
});

test("Herdr host discovery cannot guess among unrelated Zellij frontends", async () => {
  const f = fixture();
  f.addProcess("900 1 ?? /Applications/Other.app/Contents/MacOS/Other\n901 900 ttys090 zellij\n");
  f.args.set(901, "zellij a");
  await assert.rejects(discoverHerdrHost(target, { runner: f.runner }), /No unambiguous/);
  f.args.set(59130, "zellij a mellifluous-orange");
  assert.equal((await discoverHerdrHost(target, { runner: f.runner })).appPid, 700);
});

test("Herdr host discovery excludes direct terminal attachments and servers", async () => {
  const f = fixture();
  f.args.set(25563, "herdr --session default terminal attach term1");
  f.args.set(81640, "herdr --session default agent attach w1:p1");
  await assert.rejects(discoverHerdrHost(target, { runner: f.runner }), /No unambiguous/);
  assert.equal(f.calls.some(c => c.bin === "ps" && c.args.includes("eww") && c.args.includes("90744")), false);
});

test("Herdr directly named local client currently displaying remote is rejected", async () => {
  const f = fixture();
  f.setProcesses("700 1 ?? /Applications/Generic.app/Contents/MacOS/Generic\n25563 700 ttys001 herdr\n");
  f.setPids("25563");
  f.args.set(25563, "herdr --session named");
  f.env.set(25563, "herdr TERM_PROGRAM=Generic");
  f.setTitles(["spark-bc66: project"]);
  await assert.rejects(discoverHerdrHost({ ...target, machineId: undefined, sshTarget: undefined, session: "named" }, { runner: f.runner, localHostname: "localbox" }), /No unambiguous/);
});

test("Herdr session values named after commands remain valid clients", async () => {
  const f = fixture();
  f.setProcesses("700 1 ?? /Applications/Generic.app/Contents/MacOS/Generic\n25563 700 ttys001 herdr\n");
  f.setPids("25563");
  f.env.set(25563, "herdr");
  f.setTitles(["localbox: project"]);
  for (const session of ["server", "api", "terminal"]) {
    f.args.set(25563, `herdr --session ${session}`);
    assert.equal((await discoverHerdrHost({ ...target, machineId: undefined, sshTarget: undefined, session }, { runner: f.runner, localHostname: "localbox" })).herdrPid, 25563);
  }
});

test("Herdr federated remote view ignores the frontend's local session name", async () => {
  const f = fixture();
  f.args.set(25563, "herdr --session owned-local-test");
  assert.equal((await discoverHerdrHost(target, { runner: f.runner })).herdrPid, 25563);
});

test("Herdr explicit remote clients must match the entire SSH route and native session", async () => {
  const f = fixture();
  f.args.set(25563, "herdr --remote other@spark-bc66 --session default");
  await assert.rejects(discoverHerdrHost(target, { runner: f.runner }), /No unambiguous/);
  f.args.set(25563, "herdr --remote user@spark-bc66 --session another");
  await assert.rejects(discoverHerdrHost(target, { runner: f.runner }), /No unambiguous/);
  f.args.set(25563, "herdr --remote user@spark-bc66 --session default");
  assert.equal((await discoverHerdrHost(target, { runner: f.runner })).herdrPid, 25563);
});

test("Herdr ambiguous host profiles require explicit route proof instead of titles alone", async () => {
  const f = fixture();
  await assert.rejects(discoverHerdrHost({ ...target, requiresExplicitRoute: true }, { runner: f.runner }), /No unambiguous/);
  f.args.set(25563, "herdr --remote user@spark-bc66 --session default");
  assert.equal((await discoverHerdrHost({ ...target, requiresExplicitRoute: true }, { runner: f.runner })).herdrPid, 25563);
});

test("Herdr direct default local client is selected only with a verified window title", async () => {
  const f = fixture();
  f.setProcesses("700 1 ?? /Applications/Generic.app/Contents/MacOS/Generic\n25563 700 ttys001 herdr\n");
  f.setPids("25563");
  f.env.set(25563, "herdr TERM_PROGRAM=Generic");
  f.setTitles(["localbox: project", "unrelated shell"]);
  const host = await discoverHerdrHost({ ...target, machineId: undefined, sshTarget: undefined }, { runner: f.runner, localHostname: "localbox" });
  assert.equal(host.appPid, 700);
  assert.equal(host.windowHint?.title, "localbox: project");
  assert.equal(host.cmux, undefined);
  const script = f.calls.find(c => c.bin === "osascript")!.args.join(" ");
  assert.doesNotMatch(script, /frontmost\s*=|AXRaise|keystroke|activate\(/);
});

test("Herdr named local endpoint can reveal an agent in a different visible workspace", async () => {
  const f = fixture();
  f.setProcesses("700 1 ?? /Applications/Generic.app/Contents/MacOS/Generic\n25563 700 ttys001 herdr\n");
  f.setPids("25563");
  f.args.set(25563, "herdr --session named");
  f.env.set(25563, "herdr");
  f.setTitles(["localbox: other-workspace"]);
  const host = await discoverHerdrHost({ ...target, machineId: undefined, sshTarget: undefined, session: "named" }, { runner: f.runner, localHostname: "localbox" });
  assert.equal(host.herdrPid, 25563);
  assert.equal(host.windowHint?.title, "localbox: other-workspace");
  f.setTitles(["other-workspace"]);
  await assert.rejects(discoverHerdrHost({ ...target, machineId: undefined, sshTarget: undefined, session: "named" }, { runner: f.runner, localHostname: "localbox" }), /No unambiguous/);
});

test("Herdr GUI title lookup rejects ambiguous windows and missing accessibility data", async () => {
  const f = fixture();
  f.setProcesses("700 1 ?? /Applications/Generic.app/Contents/MacOS/Generic\n25563 700 ttys001 herdr\n");
  f.setPids("25563");
  f.env.set(25563, "herdr");
  f.setTitles(["spark-bc66: project", "spark-bc66: project"]);
  await assert.rejects(discoverHerdrHost(target, { runner: f.runner }), /No unambiguous/);
  f.setTitles([]);
  await assert.rejects(discoverHerdrHost(target, { runner: f.runner }), /No unambiguous/);
});

test("Herdr tmux routing fails closed when no verified multiplexer frontend is available", async () => {
  const f = fixture();
  f.setProcesses("700 1 ?? /Applications/Generic.app/Contents/MacOS/Generic\n25563 700 ttys001 herdr\n");
  f.setPids("25563");
  f.env.set(25563, "herdr TMUX=/tmp/tmux,1,0 TMUX_PANE=%2");
  await assert.rejects(discoverHerdrHost(target, { runner: f.runner }), /No unambiguous/);
});

test("Herdr nested multiplexer hints fail closed without a complete ordered route", async () => {
  for (const extra of ["TMUX=/tmp/tmux,1,0 TMUX_PANE=%1", "CMUX_WORKSPACE_ID=workspace CMUX_SURFACE_ID=surface"]) {
    const f = fixture();
    f.env.set(25563, `herdr ZELLIJ_SESSION_NAME=mellifluous-orange ZELLIJ_PANE_ID=0 ${extra}`);
    await assert.rejects(discoverHerdrHost(target, { runner: f.runner }), /No unambiguous/);
  }
});

function tmuxFixture() {
  const f = fixture();
  f.setProcesses("900 1 ?? /Applications/Generic Terminal.app/Contents/MacOS/Generic Terminal\n901 900 ttys001 /bin/zsh\n910 901 ttys001 tmux\n34420 1 ?? tmux\n34421 34420 ttys044 /bin/zsh\n25563 34421 ttys044 herdr\n");
  f.setPids("25563");
  f.env.set(25563, "herdr TMUX=/tmp/test-tmux.sock,34420,0 TMUX_PANE=%9");
  f.setTitles(["native terminal · attached session: shell"]);
  let panes = "$2\t@4\t%9\t/dev/ttys044\tspark-bc66: project\n";
  let clients = "910\t/dev/ttys001\t$2\t%3\tattached session: shell\t0\n";
  const runner: CommandRunner = async (bin, args) => {
    if (args.includes("list-panes") && args.includes("-S")) { f.calls.push({ bin, args }); return { stdout: panes, stderr: "" }; }
    if (args.includes("list-clients") && args.includes("-S")) { f.calls.push({ bin, args }); return { stdout: clients, stderr: "" }; }
    return f.runner(bin, args);
  };
  return { ...f, runner, setTmuxPanes: (s: string) => { panes = s; }, setTmuxClients: (s: string) => { clients = s; } };
}

test("Herdr host discovery maps tmux through its actual attached GUI client and current window", async () => {
  const f = tmuxFixture();
  const host = await discoverHerdrHost(target, { runner: f.runner, tmuxBin: "/custom/tmux" });
  assert.equal(host.appPid, 900);
  assert.match(host.appExecutable, /Generic Terminal/);
  assert.deepEqual(host.tmux, { socket: "/tmp/test-tmux.sock", paneId: "%9", sessionId: "$2", windowId: "@4", clientTty: "/dev/ttys001", clientPid: 910 });
  assert.equal(host.windowHint?.title, "native terminal · attached session: shell");
  assert.deepEqual(f.calls.find(c => c.args.includes("-S") && c.args.includes("list-panes"))!.args, ["-N", "-S", "/tmp/test-tmux.sock", "list-panes", "-a", "-F", "#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_tty}\t#{pane_title}"]);
  assert.equal(f.calls.filter(c => c.args.includes("-S")).every(c => c.bin === "/custom/tmux"), true);
  assert.equal(f.calls.some(c => c.args.some(a => ["switch-client", "select-pane", "send-keys"].includes(a))), false);
});

test("Herdr tmux host uses its nearest GUI ancestor when another GUI app launched it", async () => {
  const f = tmuxFixture();
  f.setProcesses("700 1 ?? /Applications/Outer.app/Contents/MacOS/Outer\n800 700 ?? /opt/homebrew/bin/node\n900 800 ?? /Applications/Actual Terminal.app/Contents/MacOS/Actual Terminal\n901 900 ttys001 /bin/zsh\n910 901 ttys001 tmux\n34420 1 ?? tmux\n34421 34420 ttys044 /bin/zsh\n25563 34421 ttys044 herdr\n");
  const host = await discoverHerdrHost(target, { runner: f.runner });
  assert.equal(host.appPid, 900);
  assert.match(host.appExecutable, /Actual Terminal/);
  assert.equal(f.calls.find(c => c.bin === "osascript")!.args.at(-1), "900");
});

test("Herdr tmux discovery refuses stale pane TTYs, wrong endpoints, and multiple attached clients", async () => {
  const f = tmuxFixture();
  f.setTmuxPanes("$2\t@4\t%9\t/dev/ttys999\tspark-bc66: project\n");
  await assert.rejects(discoverHerdrHost(target, { runner: f.runner }), /No unambiguous/);
  f.setTmuxPanes("$2\t@4\t%9\t/dev/ttys044\twrong-machine: project\n");
  await assert.rejects(discoverHerdrHost(target, { runner: f.runner }), /No unambiguous/);
  f.setTmuxPanes("$2\t@4\t%9\t/dev/ttys044\tspark-bc66: project\n");
  f.setTmuxClients("910\t/dev/ttys001\t$2\t%3\tshell\t0\n911\t/dev/ttys002\t$2\t%4\tshell\t0\n");
  await assert.rejects(discoverHerdrHost(target, { runner: f.runner }), /No unambiguous/);
});

function cmuxFixture() {
  const f = fixture();
  const workspaceId = "11111111-1111-1111-1111-111111111111", surfaceId = "22222222-2222-2222-2222-222222222222", windowId = "33333333-3333-3333-3333-333333333333";
  const appExecutable = "/Applications/Dynamic.app/Contents/MacOS/Dynamic";
  f.setProcesses(`900 1 ?? ${appExecutable}\n25563 900 ttys044 herdr\n`);
  f.setPids("25563");
  f.env.set(25563, `herdr CMUX_WORKSPACE_ID=${workspaceId} CMUX_SURFACE_ID=${surfaceId} CMUX_SOCKET_PATH=/tmp/owned-cmux.sock`);
  let title = "spark-bc66: project", memberPid = 25563;
  const runner: CommandRunner = async (bin, args) => {
    if (args.includes("identify") || args.includes("tree") || args.includes("top")) {
      f.calls.push({ bin, args });
      const value = args.includes("identify") ? { socket_path: "/tmp/owned-cmux.sock", app_executable_path: appExecutable } : { windows: [{ id: windowId, workspaces: [{ id: workspaceId, panes: [{ surfaces: [{ id: surfaceId, type: "terminal", title, ...(args.includes("top") ? { root_pids: [memberPid] } : {}) }] }] }] }] };
      return { stdout: JSON.stringify(value), stderr: "" };
    }
    return f.runner(bin, args);
  };
  return { ...f, runner, workspaceId, surfaceId, windowId, setSurfaceTitle: (s: string) => { title = s; }, setMemberPid: (n: number) => { memberPid = n; } };
}

test("Herdr host discovery verifies cmux process membership, owning window, and endpoint", async () => {
  const f = cmuxFixture();
  const host = await discoverHerdrHost(target, { runner: f.runner, cmuxBin: "/custom/cmux" });
  assert.equal(host.appPid, 900);
  assert.deepEqual(host.cmux, { socketPath: "/tmp/owned-cmux.sock", workspaceId: f.workspaceId, surfaceId: f.surfaceId, windowId: f.windowId });
  assert.deepEqual(f.calls.find(c => c.args.includes("identify"))!.args, ["--socket", "/tmp/owned-cmux.sock", "--json", "identify", "--no-caller"]);
  assert.deepEqual(f.calls.find(c => c.args.includes("top"))!.args, ["--socket", "/tmp/owned-cmux.sock", "--id-format", "both", "--json", "top", "--all", "--workspace", f.workspaceId, "--processes"]);
  assert.equal(f.calls.some(c => c.args.some(a => ["focus-surface", "select-workspace", "rpc"].includes(a))), false);
  assert.equal(f.calls.filter(c => c.args.includes("identify") || c.args.includes("tree") || c.args.includes("top")).every(c => c.bin === "/custom/cmux"), true);
});

test("Herdr cmux discovery rejects inherited IDs without process or endpoint proof", async () => {
  const f = cmuxFixture();
  f.setMemberPid(999);
  await assert.rejects(discoverHerdrHost(target, { runner: f.runner }), /No unambiguous/);
  f.setMemberPid(25563);
  f.setSurfaceTitle("wrong-machine: project");
  await assert.rejects(discoverHerdrHost(target, { runner: f.runner }), /No unambiguous/);
});
