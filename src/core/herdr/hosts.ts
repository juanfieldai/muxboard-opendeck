import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename } from "node:path";
import { hostname } from "node:os";
import { execEnv, installDirs, resolveBin, type CommandRunner } from "../exec.js";
import { resolveCmuxBin } from "../cmux/client.js";
import { sshTargetHostname, validSshTarget, type HerdrFocusTarget } from "./client.js";
import { discoverMultiplexerHost } from "./multiplexers.js";

export interface HerdrHost {
  herdrPid: number;
  appPid: number;
  /** Bundle executable discovered from ancestry, never a configured app name. */
  appExecutable: string;
  tty: string;
  zellij?: { session: string; paneId: string; attachedClientsCount: number; clientId?: number; frontendPid?: number };
  cmux?: { workspaceId: string; surfaceId: string; windowId?: string; socketPath?: string };
  tmux?: { socket: string; paneId: string; sessionId?: string; clientTty?: string; clientPid?: number; windowId?: string };
  windowHint?: { title?: string; termProgram?: string; alacrittySocket?: string; alacrittyWindowId?: string; ghosttyResourcesDir?: string };
}

export interface HerdrHostOptions {
  runner?: CommandRunner;
  zellijBin?: string;
  tmuxBin?: string;
  cmuxBin?: string;
  localHostname?: string;
  /** Canonical remote hostname, when already known by the caller. */
  remoteHostname?: string;
}

interface Process { pid: number; ppid: number; tty: string; comm: string }
interface Frontend { process: Process; args: string; app: Process | undefined }
interface Pane { id: number; is_plugin?: boolean; exited?: boolean; title?: string }

const allowedEnv = ["ZELLIJ_SESSION_NAME", "ZELLIJ_PANE_ID", "TMUX", "TMUX_PANE", "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_SOCKET_PATH", "TERM_PROGRAM", "ALACRITTY_SOCKET", "ALACRITTY_WINDOW_ID", "GHOSTTY_RESOURCES_DIR"] as const;
type HostEnv = Partial<Record<typeof allowedEnv[number], string>>;
const execFileAsync = promisify(execFile);
const dirs = installDirs("/opt/homebrew/bin");
const defaultRunner: CommandRunner = (bin, args) => execFileAsync(bin, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024, env: execEnv(dirs) });
const READ_WINDOW_TITLES = `function run(argv) {
  var app=Application('System Events').applicationProcesses.whose({unixId:Number(argv[0])})[0];
  if(!app.exists()) return '[]';
  return JSON.stringify(app.windows.name());
}`;

/** Only selected routing hints escape this parser; never retain the full env. */
export function parseHostEnvironment(text: string): HostEnv {
  const result: HostEnv = {};
  for (const key of allowedEnv) {
    const match = text.match(new RegExp(`(?:^|\\s)${key}=([^\\s]*)`));
    if (match?.[1]) result[key] = match[1];
  }
  return result;
}

function parseProcesses(text: string): Map<number, Process> {
  const rows = new Map<number, Process>();
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (match) rows.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), tty: match[3], comm: match[4].trim() });
  }
  return rows;
}

function appAncestor(pid: number, rows: Map<number, Process>): Process | undefined {
  const seen = new Set<number>();
  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    const p = rows.get(pid);
    if (!p) break;
    // A terminal launched by a process inside another GUI app is hosted by
    // the nearest application ancestor, not the outer launching application.
    if (/\.app\/Contents\/MacOS\//.test(p.comm)) return p;
    pid = p.ppid;
  }
  return undefined;
}

function words(args: string): string[] {
  return [...args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
}
function flag(args: string[], name: string): string | undefined {
  const direct = args.find(v => v.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
function clientSession(args: string[]): string {
  if (args[1] === "session" && args[2] === "attach") return args[3] ?? "default";
  return flag(args, "--session") ?? "default";
}
function isFrontend(args: string[]): boolean {
  const positional: string[] = [];
  const valueFlags = ["--session", "--remote", "--machine", "--remote-keybindings"];
  for (let i = 1; i < args.length; i++) {
    if (valueFlags.includes(args[i])) { i++; continue; }
    if (valueFlags.some(f => args[i].startsWith(`${f}=`))) continue;
    if (args[i].startsWith("-")) return false;
    positional.push(args[i]);
  }
  return positional.length === 0 || (positional[0] === "session" && positional[1] === "attach" && positional.length === 3);
}
function matchesHost(title: string, host: string): boolean {
  const lower = title.toLowerCase();
  return [host, host.split(".")[0]].some(h => !!h && (lower === h || lower.startsWith(`${h}:`) || lower.startsWith(`${h} `)));
}
function matchesWorkspace(title: string, workspace: string | undefined): boolean {
  return !!workspace && title.slice(title.indexOf(":") + 1).trim() === workspace;
}
function matchesEndpoint(target: HerdrFocusTarget, args: string[], pane: Pane | undefined, local: string, remoteHosts: string[]): boolean {
  const explicitRemote = flag(args, "--remote");
  if (target.machineId) {
    const host = sshTargetHostname(target.sshTarget);
    if (!host) return false;
    if (explicitRemote && (explicitRemote !== target.sshTarget || clientSession(args) !== target.session)) return false;
    if (target.requiresExplicitRoute && !explicitRemote) return false;
    return !!pane?.title && remoteHosts.some(h => matchesHost(pane.title!, h));
  }
  if (clientSession(args) !== target.session) return false;
  if (explicitRemote) return false;
  if (!pane) return false;
  if (!pane.title) return false;
  // An explicit local session plus local-host title proves the endpoint;
  // compatibility TabFocus can reveal a different workspace after activation.
  return matchesHost(pane.title, local) || (!!target.workspaceLabel && pane.title === target.workspaceLabel);
}

function parseClientIds(table: string): number[] {
  return table.split("\n").map(l => l.match(/^\s*(\d+)\s+(?:terminal|plugin)_\d+\s/)).filter((m): m is RegExpMatchArray => !!m).map(m => Number(m[1]));
}

/** Locate a uniquely matching existing Herdr view; never launch or alter one. */
export async function discoverHerdrHost(target: HerdrFocusTarget, opts: HerdrHostOptions = {}): Promise<HerdrHost> {
  const runner = opts.runner ?? defaultRunner;
  const zellij = resolveBin(opts.zellijBin ?? "zellij", dirs);
  const local = (opts.localHostname ?? hostname()).toLowerCase();
  const inventory = parseProcesses((await runner("ps", ["-ww", "-axo", "pid=,ppid=,tty=,comm="])).stdout);
  let pids: number[];
  try { pids = (await runner("pgrep", ["-x", "herdr"])).stdout.trim().split(/\s+/).map(Number).filter(n => n > 0 && Number.isSafeInteger(n)); }
  catch { throw new Error("No running Herdr client was found"); }

  const frontendResults = await Promise.all([...inventory.values()].filter(p => basename(p.comm) === "zellij" && p.tty !== "??").map(async process => {
    try {
      const args = (await runner("ps", ["-ww", "-p", String(process.pid), "-o", "args="])).stdout.trim();
      return words(args).includes("--server") ? undefined : { process, args, app: appAncestor(process.pid, inventory) };
    } catch { return undefined; }
  }));
  const zellijFrontends = frontendResults.filter((f): f is Frontend => !!f);
  const zellijState = new Map<string, Promise<{ panes: Pane[]; clients: number[] }>>();
  const windowTitles = new Map<number, Promise<string[]>>();
  const titlesFor = (appPid: number) => {
    if (!windowTitles.has(appPid)) windowTitles.set(appPid, (async () => {
      const raw: unknown = JSON.parse((await runner("osascript", ["-l", "JavaScript", "-e", READ_WINDOW_TITLES, String(appPid)])).stdout);
      if (!Array.isArray(raw) || !raw.every(t => typeof t === "string")) throw new Error("Invalid terminal window inventory");
      return raw as string[];
    })());
    return windowTitles.get(appPid)!;
  };
  const sessionState = (session: string) => {
    if (!zellijState.has(session)) zellijState.set(session, (async () => {
      const results = await Promise.all([
        runner(zellij, ["--session", session, "action", "list-panes", "--all", "--json"]),
        runner(zellij, ["--session", session, "action", "list-clients"]),
      ]);
      const raw: unknown = JSON.parse(results[0].stdout);
      if (!Array.isArray(raw)) throw new Error("Invalid Zellij pane inventory");
      const panes = raw.filter(p => p && typeof p === "object" && Number.isSafeInteger(p.id) && p.id >= 0) as Pane[];
      return { panes, clients: parseClientIds(results[1].stdout) };
    })());
    return zellijState.get(session)!;
  };

  const remoteHost = sshTargetHostname(target.sshTarget);
  const observedTitles = new Set<string>();
  const exactWorkspaces = new WeakSet<HerdrHost>();
  const scan = async (remoteHosts: string[]) => Promise.all(pids.map(async pid => {
    const process = inventory.get(pid);
    if (!process || process.tty === "??") return undefined;
    try {
      const args = words((await runner("ps", ["-ww", "-p", String(pid), "-o", "args="])).stdout.trim());
      if (!isFrontend(args)) return undefined;
      // Full ps environment exists only within this expression and is never
      // exposed in results, errors, logs, or persisted discovery state.
      // BSD eww already requests unlimited width; mixing it with -ww makes
      // macOS ps treat eww as an invalid PID argument.
      const env = parseHostEnvironment((await runner("ps", ["eww", "-p", String(pid), "-o", "command="])).stdout);
      // A nested multiplexer needs an ordered pane/client mapping through both
      // layers. Until that is available, activating either one could be wrong.
      if (env.ZELLIJ_SESSION_NAME && (env.TMUX || env.CMUX_WORKSPACE_ID || env.CMUX_SURFACE_ID)) return undefined;
      if (env.TMUX || env.CMUX_WORKSPACE_ID || env.CMUX_SURFACE_ID) {
        let provenTitle: string | undefined;
        const host = await discoverMultiplexerHost({ env, target, herdrPid: pid, tty: process.tty, runner,
          appAncestor: frontendPid => appAncestor(frontendPid, inventory),
          matchesEndpoint: title => {
            observedTitles.add(title);
            const matches = matchesEndpoint(target, args, { id: -1, title }, local, remoteHosts);
            if (matches) provenTitle = title;
            return matches;
          }, tmuxBin: resolveBin(opts.tmuxBin ?? "tmux", dirs), cmuxBin: resolveCmuxBin(opts.cmuxBin ?? "cmux") });
        if (host && provenTitle && matchesWorkspace(provenTitle, target.workspaceLabel)) exactWorkspaces.add(host);
        return host;
      }
      let app = appAncestor(pid, inventory);
      let zellijHost: HerdrHost["zellij"];
      let windowTitle: string | undefined;
      let endpointTitle: string | undefined;
      if (env.ZELLIJ_SESSION_NAME) {
        const sessionName = env.ZELLIJ_SESSION_NAME;
        if (!/^\d+$/.test(env.ZELLIJ_PANE_ID ?? "")) return undefined;
        const state = await sessionState(sessionName);
        const paneId = Number(env.ZELLIJ_PANE_ID);
        const pane = state.panes.find(p => p.id === paneId && !p.is_plugin && !p.exited);
        if (pane?.title) observedTitles.add(pane.title);
        if (!pane || !matchesEndpoint(target, args, pane, local, remoteHosts) || state.clients.length !== 1) return undefined;
        endpointTitle = pane.title;
        const matching = zellijFrontends.filter(f => f.app && (flag(words(f.args), "--session") === sessionName || words(f.args).includes(sessionName)));
        const front = matching.length === 1 ? matching[0] : zellijFrontends.length === 1 ? zellijFrontends[0] : undefined;
        if (matching.length > 1 || !front?.app) return undefined;
        app = front.app;
        zellijHost = { session: sessionName, paneId: `terminal_${paneId}`, attachedClientsCount: state.clients.length, clientId: state.clients[0], frontendPid: front.process.pid };
      } else {
        if (!app) return undefined;
        const titles = await titlesFor(app.pid);
        for (const title of titles) observedTitles.add(title);
        let matches = titles.filter(title => matchesEndpoint(target, args, { id: -1, title }, local, remoteHosts));
        const exact = matches.filter(title => matchesWorkspace(title, target.workspaceLabel));
        if (exact.length) matches = exact;
        if (matches.length !== 1) return undefined;
        windowTitle = matches[0];
        endpointTitle = windowTitle;
      }
      if (!app) return undefined;
      const host: HerdrHost = { herdrPid: pid, appPid: app.pid, appExecutable: app.comm, tty: process.tty, zellij: zellijHost };
      if (endpointTitle && matchesWorkspace(endpointTitle, target.workspaceLabel)) exactWorkspaces.add(host);
      const hint = { title: windowTitle, termProgram: env.TERM_PROGRAM, alacrittySocket: env.ALACRITTY_SOCKET, alacrittyWindowId: env.ALACRITTY_WINDOW_ID, ghosttyResourcesDir: env.GHOSTTY_RESOURCES_DIR };
      if (Object.values(hint).some(Boolean)) host.windowHint = hint;
      return host;
    } catch { return undefined; }
  }));
  let candidates = await scan(remoteHost ? [remoteHost] : []);
  if (target.machineId && remoteHost && ![...observedTitles].some(title => matchesHost(title, remoteHost))) {
    // Saved SSH aliases often differ from the server hostname displayed by
    // Herdr. Resolve only when needed; never guess from similar names.
    let canonical = opts.remoteHostname;
    if (!canonical && validSshTarget(target.sshTarget)) {
      try {
        canonical = (await runner("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", target.sshTarget, "hostname"])).stdout.trim();
      } catch { /* Missing/auth-failed alias resolution must fail closed. */ }
    }
    if (canonical && /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(canonical)) candidates = await scan([remoteHost, canonical.toLowerCase()]);
  }
  let usable = candidates.filter((candidate): candidate is HerdrHost => !!candidate);
  const exact = usable.filter(candidate => exactWorkspaces.has(candidate));
  if (exact.length) usable = exact;
  if (!usable.length) throw new Error("No unambiguous existing Herdr view shows this session and machine");
  if (usable.length !== 1) throw new Error("Multiple existing Herdr views match; host activation is ambiguous");
  return usable[0];
}
