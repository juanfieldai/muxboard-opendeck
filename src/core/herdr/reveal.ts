import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execEnv, installDirs, resolveBin, type CommandRunner } from "../exec.js";
import type { HerdrFocusTarget } from "./client.js";
import { discoverHerdrHost, type HerdrHost } from "./hosts.js";
import { resolveCmuxBin } from "../cmux/client.js";

const exec = promisify(execFile);
const dirs = installDirs("/opt/homebrew/bin");
const defaultRunner: CommandRunner = (bin, args) => exec(resolveBin(bin, dirs), args, { timeout: 5000, env: execEnv(dirs) });

// The app and window come from the running client. No terminal application is
// started, and a multi-window host must have a unique matching window title.
const REVEAL_WINDOW = `function run(argv) {
  var pid=Number(argv[0]), hint=argv[1];
  var app=Application('System Events').applicationProcesses.whose({unixId:pid})[0];
  if (!app.exists()) throw Error('Herdr terminal host is no longer running');
  var titles=app.windows.name();
  var matches=[];
  for(var i=0;i<titles.length;i++) if(hint && titles[i].indexOf(hint)!==-1) matches.push(i);
  var index=hint?(matches.length===1?matches[0]:-1):(titles.length===1?0:-1);
  if(index<0) throw Error('Cannot identify a unique window for the Herdr session');
  var window=app.windows[index];
  var minimized=window.attributes.byName('AXMinimized');
  if(minimized.exists() && minimized.value()) minimized.value=false;
  app.frontmost=true;
  window.actions.byName('AXRaise').perform();
  if(!app.frontmost()) throw Error('Could not foreground the Herdr terminal host');
  return JSON.stringify({pid:pid,title:titles[index]});
}`;
const FOREGROUND_PROCESS = `function run(argv) {
  var app=Application('System Events').applicationProcesses.whose({unixId:Number(argv[0])})[0];
  if(!app.exists()) throw Error('Herdr terminal host is no longer running');
  app.frontmost=true;
  if(!app.frontmost()) throw Error('Could not foreground the Herdr terminal host');
}`;

export interface HerdrRevealOptions {
  runner?: CommandRunner;
  discover?: (target: HerdrFocusTarget) => Promise<HerdrHost>;
}

/** Reveal the already running Herdr client inside its discovered terminal host. */
export class HerdrReveal {
  private readonly runner: CommandRunner;
  private readonly discover: (target: HerdrFocusTarget) => Promise<HerdrHost>;
  constructor(opts: HerdrRevealOptions = {}) {
    this.runner = opts.runner ?? defaultRunner;
    this.discover = opts.discover ?? (target => discoverHerdrHost(target));
  }
  async show(target: HerdrFocusTarget): Promise<void> {
    const host = await this.discover(target);
    if ([host.tmux, host.cmux, host.zellij].filter(Boolean).length > 1) {
      throw new Error("Cannot safely reveal Herdr through multiple nested host mappings");
    }
    if (host.zellij && host.zellij.attachedClientsCount !== 1) {
      throw new Error("Cannot safely reveal Herdr in a Zellij session with multiple attached clients");
    }
    if (!Number.isSafeInteger(host.appPid) || host.appPid <= 0) throw new Error("Herdr terminal host is no longer available");
    if (host.cmux) {
      const { socketPath, windowId, workspaceId, surfaceId } = host.cmux;
      const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
      if (!socketPath || !socketPath.startsWith("/") || !windowId || [windowId, workspaceId, surfaceId].some(id => !uuid.test(id))) {
        throw new Error("Invalid Herdr cmux host identity");
      }
      const rpc = (method: string, params: object) => this.runner(resolveCmuxBin("cmux"), ["--socket", socketPath, "--json", "rpc", method, JSON.stringify(params)]);
      for (const [method, params] of [
        ["workspace.select", { workspace_id: workspaceId }],
        ["surface.focus", { workspace_id: workspaceId, surface_id: surfaceId }],
        ["window.focus", { window_id: windowId }],
      ] as const) await rpc(method, params);
      await this.runner("osascript", ["-l", "JavaScript", "-e", FOREGROUND_PROCESS, String(host.appPid)]);
      const identity = JSON.parse((await rpc("system.identify", {})).stdout);
      const same = (actual: unknown, expected: string) => typeof actual === "string" && actual.toLowerCase() === expected.toLowerCase();
      if (!same(identity.focused?.window_id, windowId) || !same(identity.focused?.workspace_id, workspaceId) ||
        !same(identity.focused?.surface_id, surfaceId) || identity.focused?.surface_type !== "terminal") {
        throw new Error("Herdr cmux surface did not become visible in its owning window");
      }
      return;
    }
    if (host.tmux && (!/^%\d+$/.test(host.tmux.paneId) || !host.tmux.clientTty || !host.windowHint?.title ||
      !/^\$\d+$/.test(host.tmux.sessionId ?? "") || !/^@\d+$/.test(host.tmux.windowId ?? "") ||
      !Number.isSafeInteger(host.tmux.clientPid) || (host.tmux.clientPid ?? 0) <= 0 || !host.tmux.socket.startsWith("/"))) {
      throw new Error("Invalid or unmapped Herdr tmux host identity");
    }
    const hint = host.windowHint?.title ?? host.zellij?.session ?? "";
    await this.runner("osascript", ["-l", "JavaScript", "-e", REVEAL_WINDOW, String(host.appPid), hint]);
    if (host.tmux) {
      const { socket, paneId, clientTty, clientPid, sessionId, windowId } = host.tmux;
      const prefix = ["-N", "-S", socket];
      await this.runner("tmux", [...prefix, "switch-client", "-c", clientTty!, "-t", paneId]);
      const { stdout } = await this.runner("tmux", [...prefix, "display-message", "-p", "-c", clientTty!,
        "#{client_pid}\t#{client_tty}\t#{session_id}\t#{window_id}\t#{pane_id}"]);
      const actual = stdout.trim().split("\t");
      if (Number(actual[0]) !== clientPid || actual[1] !== clientTty || actual[2] !== sessionId ||
        actual[3] !== windowId || actual[4] !== paneId) {
        throw new Error("Herdr tmux pane did not become visible in the discovered client");
      }
    }
    if (host.zellij) {
      const { session, paneId } = host.zellij;
      if (!/^terminal_\d+$/.test(paneId)) throw new Error("Invalid Herdr host pane identity");
      try {
        await this.runner("zellij", ["--session", session, "action", "focus-pane-id", paneId]);
      } catch (err) {
        const detail = String(err) + (err && typeof err === "object" && "stderr" in err ? String(err.stderr) : "");
        if (!/already focused/i.test(detail)) throw err;
      }
      const { stdout } = await this.runner("zellij", ["--session", session, "action", "list-clients"]);
      const clients = stdout.trim().split(/\r?\n/).slice(1).map(line => line.trim().split(/\s+/));
      if (clients.length !== 1 || clients[0]?.[1] !== paneId ||
        (host.zellij.clientId !== undefined && Number(clients[0]?.[0]) !== host.zellij.clientId)) {
        throw new Error("Herdr host pane did not become visible in the attached Zellij client");
      }
    }
  }
}
