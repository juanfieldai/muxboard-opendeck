import type { CommandRunner } from "../exec.js";
import type { HerdrFocusTarget } from "./client.js";
import type { HerdrHost } from "./hosts.js";

export interface MultiplexerHost extends Omit<HerdrHost, "tmux" | "cmux"> {
  tmux?: { socket: string; paneId: string; sessionId: string; windowId: string; clientTty: string; clientPid: number };
  cmux?: { workspaceId: string; surfaceId: string; windowId: string; socketPath: string };
}
export interface MultiplexerHostOptions {
  env: Partial<Record<string, string>>;
  target: HerdrFocusTarget;
  herdrPid: number;
  tty: string;
  runner: CommandRunner;
  appAncestor(pid: number): { pid: number; comm: string } | undefined;
  /** Includes the caller's verified session/remote route, not only workspace. */
  matchesEndpoint(title: string): boolean;
  tmuxBin?: string;
  cmuxBin?: string;
}

const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const absolute = (s: unknown): s is string => typeof s === "string" && s.startsWith("/") && !/[\r\n\0]/.test(s);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const ttyPath = (tty: string) => tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
const READ_WINDOW_TITLES = `function run(argv) {
  var app=Application('System Events').applicationProcesses.whose({unixId:Number(argv[0])})[0];
  if(!app.exists()) return '[]';
  return JSON.stringify(app.windows.name());
}`;
export const sameMultiplexerId = (a: unknown, b: unknown): boolean => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

function rows(text: string, count: number): string[][] | undefined {
  const result = text.trimEnd().split("\n").filter(Boolean).map(line => line.split("\t"));
  return result.every(row => row.length === count) ? result : undefined;
}

async function tmuxHost(o: MultiplexerHostOptions): Promise<MultiplexerHost | undefined> {
  const tmux = o.env.TMUX?.match(/^(.*),(\d+),(\d+)$/);
  const paneId = o.env.TMUX_PANE;
  if (!tmux || !absolute(tmux[1]) || !/^%\d+$/.test(paneId ?? "")) return undefined;
  const socket = tmux[1];
  const bin = o.tmuxBin ?? "tmux";
  const base = ["-N", "-S", socket];
  const [panesOutput, clientsOutput] = await Promise.all([
    o.runner(bin, [...base, "list-panes", "-a", "-F", "#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_tty}\t#{pane_title}"]),
    o.runner(bin, [...base, "list-clients", "-F", "#{client_pid}\t#{client_tty}\t#{session_id}\t#{pane_id}\t#{pane_title}\t#{client_control_mode}"]),
  ]);
  const panes = rows(panesOutput.stdout, 5), clients = rows(clientsOutput.stdout, 6);
  if (!panes || !clients) return undefined;
  const matching = panes.filter(p => p[2] === paneId && p[3] === ttyPath(o.tty) && /^\$\d+$/.test(p[0]) && /^@\d+$/.test(p[1]) && o.matchesEndpoint(p[4]));
  if (matching.length !== 1) return undefined;
  const [sessionId, windowId] = matching[0];
  // Only a session already shown by exactly one interactive client is safe.
  const attached = clients.filter(c => c[2] === sessionId);
  if (attached.length !== 1) return undefined;
  const client = attached[0];
  if (!/^\d+$/.test(client[0]) || !client[1].startsWith("/dev/") || !/^%\d+$/.test(client[3]) || client[5] !== "0") return undefined;
  const clientPid = Number(client[0]);
  const app = o.appAncestor(clientPid);
  if (!Number.isSafeInteger(clientPid) || !app) return undefined;
  // This is the CURRENT visible pane title, used only to locate its native
  // window before changing tmux focus. Never infer a window from target title.
  const currentPaneTitle = client[4];
  if (!currentPaneTitle || currentPaneTitle.length < 3) return undefined;
  const titles: unknown = JSON.parse((await o.runner("osascript", ["-l", "JavaScript", "-e", READ_WINDOW_TITLES, String(app.pid)])).stdout);
  if (!Array.isArray(titles) || !titles.every(t => typeof t === "string")) return undefined;
  const native = titles.filter(t => t.includes(currentPaneTitle));
  if (native.length !== 1) return undefined;
  return { herdrPid: o.herdrPid, tty: o.tty, appPid: app.pid, appExecutable: app.comm,
    tmux: { socket, paneId: paneId!, sessionId, windowId, clientTty: client[1], clientPid }, windowHint: { title: native[0] } };
}

function containsPid(value: unknown, pid: number): boolean {
  if (Array.isArray(value)) return value.some(v => containsPid(v, pid));
  if (!record(value)) return false;
  if (value.pid === pid) return true;
  for (const key of ["root_pids", "tty_process_pids", "top_level_pids", "cmux_process_pids"]) {
    if (Array.isArray(value[key]) && value[key].includes(pid)) return true;
  }
  return Object.values(value).some(v => containsPid(v, pid));
}

function surfaceMatches(value: unknown, workspaceId: string, surfaceId: string, pid: number): number {
  if (!record(value) || !Array.isArray(value.windows)) return 0;
  let count = 0;
  for (const window of value.windows) {
    if (!record(window) || !Array.isArray(window.workspaces)) continue;
    for (const workspace of window.workspaces) {
      if (!record(workspace) || !sameMultiplexerId(workspace.id, workspaceId) || !Array.isArray(workspace.panes)) continue;
      for (const pane of workspace.panes) {
        if (!record(pane) || !Array.isArray(pane.surfaces)) continue;
        for (const surface of pane.surfaces) {
          if (record(surface) && sameMultiplexerId(surface.id, surfaceId) && containsPid(surface, pid)) count++;
        }
      }
    }
  }
  return count;
}

async function cmuxHost(o: MultiplexerHostOptions): Promise<MultiplexerHost | undefined> {
  const workspaceId = o.env.CMUX_WORKSPACE_ID, surfaceId = o.env.CMUX_SURFACE_ID;
  if (!workspaceId || !surfaceId || !uuid.test(workspaceId) || !uuid.test(surfaceId)) return undefined;
  const bin = o.cmuxBin ?? "cmux";
  let socketPath = o.env.CMUX_SOCKET_PATH;
  if (socketPath !== undefined && !absolute(socketPath)) return undefined;
  const identify: unknown = JSON.parse((await o.runner(bin, [...(socketPath ? ["--socket", socketPath] : []), "--json", "identify", "--no-caller"])).stdout);
  if (!record(identify) || !absolute(identify.socket_path) || typeof identify.app_executable_path !== "string") return undefined;
  if (socketPath && identify.socket_path !== socketPath) return undefined;
  socketPath = identify.socket_path;
  const base = ["--socket", socketPath];
  const [treeOutput, topOutput] = await Promise.all([
    // Explicit workspace beats the CLI's inherited caller workspace. --all
    // still resolves the owning window rather than assuming the active one.
    o.runner(bin, [...base, "--id-format", "both", "--json", "tree", "--all", "--workspace", workspaceId]),
    o.runner(bin, [...base, "--id-format", "both", "--json", "top", "--all", "--workspace", workspaceId, "--processes"]),
  ]);
  const tree: unknown = JSON.parse(treeOutput.stdout), top: unknown = JSON.parse(topOutput.stdout);
  if (!record(tree) || !Array.isArray(tree.windows) || surfaceMatches(top, workspaceId, surfaceId, o.herdrPid) !== 1) return undefined;
  const app = o.appAncestor(o.herdrPid);
  if (!app || app.comm !== identify.app_executable_path) return undefined;
  const candidates: MultiplexerHost[] = [];
  for (const window of tree.windows) {
    if (!record(window) || typeof window.id !== "string" || !uuid.test(window.id) || !Array.isArray(window.workspaces)) continue;
    for (const workspace of window.workspaces) {
      if (!record(workspace) || !sameMultiplexerId(workspace.id, workspaceId) || !Array.isArray(workspace.panes)) continue;
      for (const pane of workspace.panes) {
        if (!record(pane) || !Array.isArray(pane.surfaces)) continue;
        for (const surface of pane.surfaces) {
          if (!record(surface) || !sameMultiplexerId(surface.id, surfaceId) || surface.type !== "terminal" || typeof surface.title !== "string" || !o.matchesEndpoint(surface.title)) continue;
          candidates.push({ herdrPid: o.herdrPid, tty: o.tty, appPid: app.pid, appExecutable: app.comm,
            cmux: { workspaceId, surfaceId, windowId: window.id, socketPath } });
        }
      }
    }
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Read-only routing discovery. Nested muxes need an ordered adapter chain. */
export async function discoverMultiplexerHost(o: MultiplexerHostOptions): Promise<MultiplexerHost | undefined> {
  if (o.env.ZELLIJ_SESSION_NAME || (o.env.TMUX && (o.env.CMUX_WORKSPACE_ID || o.env.CMUX_SURFACE_ID))) return undefined;
  try {
    if (o.env.TMUX) return await tmuxHost(o);
    if (o.env.CMUX_WORKSPACE_ID || o.env.CMUX_SURFACE_ID) return await cmuxHost(o);
    return undefined;
  } catch { return undefined; }
}
