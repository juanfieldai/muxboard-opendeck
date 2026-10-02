import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type CommandRunner, execEnv, installDirs, resolveBin } from "../exec.js";
import type { AttentionItem } from "../types.js";
import { herdrEntityKey, normalizeHerdrAgent, type HerdrObservation, type HerdrSession, type HerdrSnapshot } from "./normalize.js";

const dirs = installDirs("/opt/homebrew/bin");
const execFileAsync = promisify(execFile);
const defaultRunner: CommandRunner = async (bin, args) => {
  const env = execEnv(dirs);
  // Explicit session selection must never inherit an unrelated pane socket.
  delete env.HERDR_SOCKET_PATH;
  delete env.HERDR_SESSION;
  return execFileAsync(bin, args, { env, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
};

export interface HerdrClientOptions {
  bin?: string;
  sessions?: string[];
  runner?: CommandRunner;
  now?: () => number;
  machines?: string[];
  includeMachines?: boolean;
  machinePollMs?: number;
  sshRunner?: CommandRunner;
}

export interface HerdrHealth {
  running: number;
  successful: number;
  errors: Array<{ session: string; message: string }>;
}

/** Fresh, verified route for revealing an existing terminal view. */
export interface HerdrFocusTarget {
  session: string;
  machineId?: string;
  sshTarget?: string;
  socketPath: string;
  terminalId: string;
  paneId: string;
  workspaceLabel?: string;
  machineLabel?: string;
  serverVersion?: string;
  /** Host-only titles cannot distinguish configured users or native sessions. */
  requiresExplicitRoute?: boolean;
}

const record = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const errorMessage = (err: unknown): string => err instanceof Error ? err.message : String(err);
export const validSshTarget = (target: unknown): target is string =>
  typeof target === "string" && target.length > 0 && !target.startsWith("-") && !/[\s\x00-\x1f\x7f]/.test(target);

export function sshTargetHostname(target: string | undefined): string | undefined {
  if (!target) return undefined;
  try {
    if (target.startsWith("ssh://")) return new URL(target).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch { return undefined; }
  return target.split("@").at(-1)?.replace(/^\[|\]$/g, "").toLowerCase();
}

/** Quote a single literal token for the remote POSIX shell used by ssh. */
export const posixQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const legacyLauncher = [
  "remote_bin=$(command -v herdr 2>/dev/null) || remote_bin=''",
  'if [ -z "$remote_bin" ]; then',
  '  for candidate in "$HOME/.local/bin/herdr" /usr/local/bin/herdr /opt/homebrew/bin/herdr; do',
  '    if [ -x "$candidate" ]; then remote_bin=$candidate; break; fi',
  "  done",
  "fi",
  'if [ -z "$remote_bin" ]; then echo "herdr: remote binary not found" >&2; exit 127; fi',
  'exec "$remote_bin" "$@"',
].join("\n");

export function remoteHerdrCommand(args: string[]): string {
  return ["sh", "-c", legacyLauncher, "sh", ...args].map(posixQuote).join(" ");
}
function parse(stdout: string, command: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new Error(`herdr ${command}: non-JSON response`); }
  if (!record(value)) throw new Error(`herdr ${command}: invalid response`);
  if (value.error) {
    const err = record(value.error) ? value.error : {};
    throw new Error(`herdr ${command}: ${String(err.code ?? "error")} ${String(err.message ?? "")}`);
  }
  return value;
}

function snapshot(stdout: string): HerdrSnapshot {
  const env = parse(stdout, "api snapshot");
  const result = env.result;
  if (!record(result) || result.type !== "session_snapshot" || !record(result.snapshot)) {
    throw new Error("herdr api snapshot: missing snapshot");
  }
  const raw = result.snapshot;
  if (!Array.isArray(raw.agents) || !Array.isArray(raw.workspaces)) throw new Error("herdr api snapshot: invalid arrays");
  const statuses = new Set(["idle", "working", "blocked", "done", "unknown"]);
  for (const agent of raw.agents) {
    if (!record(agent) || !["terminal_id", "pane_id", "workspace_id", "tab_id"].every(k => typeof agent[k] === "string" && agent[k]) || !statuses.has(String(agent.agent_status))) {
      throw new Error("herdr api snapshot: invalid agent");
    }
  }
  if (!raw.workspaces.every(w => record(w) && typeof w.workspace_id === "string")) throw new Error("herdr api snapshot: invalid workspace");
  return raw as unknown as HerdrSnapshot;
}

/** Local sessions and enabled saved machines; polling never starts a server. */
export class HerdrClient {
  private readonly bin: string;
  private readonly runner: CommandRunner;
  private readonly now: () => number;
  private readonly allowlist?: Set<string>;
  private readonly machineAllowlist?: Set<string>;
  private readonly includeMachines: boolean;
  private readonly machinePollMs: number;
  private readonly sshRunner: CommandRunner;
  private readonly legacyRoutes = new Set<string>();
  private readonly remoteReads = new Map<string, { at: number; healthy: boolean; error?: string }>();
  private sessions = new Map<string, HerdrSession>();
  private cached = new Map<string, AttentionItem[]>();
  private observations = new Map<string, HerdrObservation>();
  health: HerdrHealth = { running: 0, successful: 0, errors: [] };
  private discoveryErrors: HerdrHealth["errors"] = [];
  private discoveryComplete = false;
  private ambiguousRemoteHosts = new Set<string>();

  get hasTargets(): boolean { return this.discoveryComplete && this.sessions.size > 0; }
  get noTargets(): boolean { return this.discoveryComplete && this.sessions.size === 0 && this.discoveryErrors.length === 0; }

  /** Includes cached failed sessions, but never sessions known to be stopped. */
  get lastGoodItems(): AttentionItem[] { return [...this.cached.values()].flat(); }

  /** A user-requested refresh bypasses the normal SSH polling cadence. */
  invalidateRemoteCache(): void { this.remoteReads.clear(); }

  constructor(opts: HerdrClientOptions = {}) {
    this.bin = resolveBin(opts.bin ?? "herdr", dirs);
    this.runner = opts.runner ?? defaultRunner;
    this.now = opts.now ?? Date.now;
    this.allowlist = opts.sessions?.length ? new Set(opts.sessions) : undefined;
    this.machineAllowlist = opts.machines?.length ? new Set(opts.machines) : undefined;
    this.includeMachines = opts.includeMachines ?? true;
    this.machinePollMs = opts.machinePollMs ?? 15_000;
    this.sshRunner = opts.sshRunner ?? defaultRunner;
  }

  private async localSessions(): Promise<HerdrSession[]> {
    const { stdout } = await this.runner(this.bin, ["session", "list", "--json"]);
    const data = parse(stdout, "session list");
    if (!Array.isArray(data.sessions)) throw new Error("herdr session list: sessions is not an array");
    for (const s of data.sessions) {
      if (!record(s) || typeof s.name !== "string" || !s.name || typeof s.socket_path !== "string" || !s.socket_path || typeof s.running !== "boolean") throw new Error("herdr session list: invalid session");
    }
    return (data.sessions as unknown as HerdrSession[]).filter(s => s.running && (!this.allowlist || this.allowlist.has(s.name)));
  }

  private async machines(): Promise<HerdrSession[]> {
    const { stdout } = await this.runner(this.bin, ["machine", "list", "--json"]);
    let data: unknown;
    try { data = JSON.parse(stdout); } catch { throw new Error("herdr machine list: non-JSON response"); }
    if (!Array.isArray(data) || !data.every(m => record(m) && typeof m.id === "string" && m.id && typeof m.label === "string" && typeof m.session === "string" && m.session && typeof m.enabled === "boolean")) {
      throw new Error("herdr machine list: invalid profiles");
    }
    const routes = new Map<string, Set<string>>();
    for (const m of data.filter(m => m.enabled)) {
      const host = sshTargetHostname(typeof m.target === "string" ? m.target : undefined);
      if (host) routes.set(host, (routes.get(host) ?? new Set()).add(JSON.stringify([m.target, m.session])));
    }
    this.ambiguousRemoteHosts = new Set([...routes].filter(([, values]) => values.size > 1).map(([host]) => host));
    return data.filter(m => m.enabled && (!this.machineAllowlist || this.machineAllowlist.has(m.id) || this.machineAllowlist.has(m.label)))
      .map(m => ({ name: m.session, machineId: m.id, label: m.label, sshTarget: typeof m.target === "string" ? m.target : undefined, socket_path: `remote:${JSON.stringify([m.id, m.session])}`, running: true }));
  }

  private async discover(): Promise<HerdrSession[]> {
    const results = await Promise.allSettled([this.localSessions(), this.includeMachines ? this.machines() : Promise.resolve([])]);
    this.discoveryErrors = [];
    const targets: HerdrSession[] = [];
    results.forEach((result, i) => {
      if (result.status === "fulfilled") targets.push(...result.value);
      else {
        this.discoveryErrors.push({ session: i === 0 ? "local discovery" : "machine discovery", message: errorMessage(result.reason) });
        // A failed inventory cannot prove previously known targets stopped.
        targets.push(...[...this.sessions.values()].filter(s => i === 0 ? !s.machineId : !!s.machineId));
      }
    });
    this.discoveryComplete = true;
    this.reconcileTargets(targets);
    if (!targets.length && this.discoveryErrors.length) throw new Error(this.discoveryErrors.map(e => e.message).join("; "));
    return targets;
  }

  private clearTarget(socket: string): void {
    this.cached.delete(socket);
    this.remoteReads.delete(socket);
    this.legacyRoutes.delete(socket);
    const prefix = `herdr:${JSON.stringify([socket]).slice(0, -1)},`;
    for (const key of this.observations.keys()) if (key.startsWith(prefix)) this.observations.delete(key);
  }

  private reconcileTargets(targets: HerdrSession[]): void {
    const next = new Map(targets.map(s => [s.socket_path, s]));
    const known = new Set([...this.sessions.keys(), ...this.cached.keys(), ...this.remoteReads.keys(), ...this.legacyRoutes]);
    for (const socket of known) {
      const old = this.sessions.get(socket);
      const current = next.get(socket);
      if (!current || (current.machineId && old && current.sshTarget !== old.sshTarget)) this.clearTarget(socket);
    }
    this.sessions = next;
  }

  private prefix(session: HerdrSession): string[] {
    return session.machineId ? ["--machine", session.machineId] : ["--session", session.name];
  }

  private async legacyRequest(session: HerdrSession, args: string[]): Promise<{ stdout: string; stderr: string }> {
    const target = session.sshTarget;
    // Saved SSH targets are passed as one argv element, never shell text. Reject
    // option-looking targets and whitespace/control characters defensively.
    if (!validSshTarget(target)) {
      throw new Error("herdr SSH fallback: invalid saved machine target");
    }
    const command = remoteHerdrCommand(["--session", session.name, ...args]);
    return this.sshRunner("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", target, command]);
  }

  private async request(session: HerdrSession, args: string[]): Promise<{ stdout: string; stderr: string }> {
    if (this.legacyRoutes.has(session.socket_path)) return this.legacyRequest(session, args);
    try {
      return await this.runner(this.bin, [...this.prefix(session), ...args]);
    } catch (err) {
      const stderr = record(err) ? String(err.stderr ?? "") : "";
      const detail = `${String(err)} ${stderr}`;
      if (!session.machineId || !detail.includes("does not support machine API forwarding")) throw err;
      // This client-side compatibility check proves the old remote CLI lacks
      // forwarding, not that the session/API is unavailable. Reuse its public
      // CLI through noninteractive SSH without installing or starting anything.
      this.legacyRoutes.add(session.socket_path);
      return this.legacyRequest(session, args);
    }
  }

  private async read(session: HerdrSession): Promise<HerdrSnapshot> {
    const { stdout } = await this.request(session, ["api", "snapshot"]);
    return snapshot(stdout);
  }

  private normalize(session: HerdrSession, data: HerdrSnapshot): AttentionItem[] {
    const now = this.now();
    const live = new Set<string>();
    const items: AttentionItem[] = [];
    for (const agent of data.agents) {
      const key = herdrEntityKey(session, agent.terminal_id);
      live.add(key);
      const label = data.workspaces.find(w => w.workspace_id === agent.workspace_id)?.label;
      const normalized = normalizeHerdrAgent(session, agent, typeof label === "string" ? label : "", this.observations.get(key), now);
      this.observations.set(key, normalized.observation);
      if (normalized.item) items.push(normalized.item);
    }
    for (const key of this.observations.keys()) {
      if (key.startsWith(`herdr:${JSON.stringify([session.socket_path]).slice(0, -1)},`) && !live.has(key)) this.observations.delete(key);
    }
    this.cached.set(session.socket_path, items);
    return items;
  }

  async listAttention(): Promise<AttentionItem[]> {
    const sessions = await this.discover();
    const results = await Promise.allSettled(sessions.map(async s => {
      const last = this.remoteReads.get(s.socket_path);
      if (s.machineId && last && this.now() - last.at < this.machinePollMs) {
        if (!last.healthy) throw new Error(last.error ?? "remote session unavailable");
        return this.cached.get(s.socket_path) ?? [];
      }
      try {
        const rows = this.normalize(s, await this.read(s));
        if (s.machineId) this.remoteReads.set(s.socket_path, { at: this.now(), healthy: true });
        return rows;
      } catch (err) {
        if (s.machineId) this.remoteReads.set(s.socket_path, { at: this.now(), healthy: false, error: errorMessage(err) });
        throw err;
      }
    }));
    this.health = { running: sessions.length, successful: 0, errors: [...this.discoveryErrors] };
    results.forEach((result, i) => {
      if (result.status === "fulfilled") this.health.successful++;
      else this.health.errors.push({ session: sessions[i].label ? `${sessions[i].label}/${sessions[i].name}` : sessions[i].name, message: errorMessage(result.reason) });
    });
    if (sessions.length && !this.health.successful) throw new Error(`herdr all sessions failed: ${this.health.errors.map(e => `${e.session}: ${e.message}`).join("; ")}`);
    return this.lastGoodItems;
  }

  async reachable(): Promise<boolean> {
    try { return (await this.discover()).length > 0; } catch { return false; }
  }

  private async resolve(item: AttentionItem) {
    if (item.source !== "herdr" || !item.herdr) throw new Error("herdr focus: missing terminal identity");
    const sessions = await this.discover();
    const session = sessions.find(s => s.name === item.herdr!.session && s.machineId === item.herdr!.machineId && herdrEntityKey(s, item.herdr!.terminalId) === item.entityKey);
    if (!session) throw new Error("herdr focus: session is no longer running");
    if (session.machineId && !validSshTarget(session.sshTarget)) throw new Error("herdr focus: invalid saved machine target");
    const data = await this.read(session);
    const agent = data.agents.find(a => a.terminal_id === item.herdr!.terminalId);
    if (!agent) throw new Error("herdr focus: selected terminal is no longer an agent");
    return { session, data, agent };
  }

  /** Resolve current native identity without changing focus or acknowledging work. */
  async resolveFocusTarget(item: AttentionItem): Promise<HerdrFocusTarget> {
    const { session, agent, data } = await this.resolve(item);
    const label = data.workspaces.find(w => w.workspace_id === agent.workspace_id)?.label;
    return { session: session.name, machineId: session.machineId, sshTarget: session.sshTarget,
      socketPath: session.socket_path, terminalId: agent.terminal_id, paneId: agent.pane_id,
      workspaceLabel: typeof label === "string" ? label : undefined, machineLabel: session.label,
      serverVersion: typeof data.version === "string" ? data.version : undefined,
      requiresExplicitRoute: session.machineId ? this.ambiguousRemoteHosts.has(sshTargetHostname(session.sshTarget) ?? "") : undefined };
  }

  async focus(item: AttentionItem, expectedTarget?: HerdrFocusTarget): Promise<void> {
    const { session, data, agent } = await this.resolve(item);
    // The host was resolved on an earlier route. Profile edits must never
    // acknowledge a different host or terminal after revealing that view.
    // Pane IDs intentionally are not compared: a live terminal can move panes.
    if (expectedTarget && (expectedTarget.session !== session.name ||
      expectedTarget.machineId !== session.machineId || expectedTarget.sshTarget !== session.sshTarget ||
      expectedTarget.socketPath !== session.socket_path || expectedTarget.terminalId !== agent.terminal_id)) {
      throw new Error("herdr focus: target changed after the existing host was resolved");
    }
    this.normalize(session, data);
    const key = herdrEntityKey(session, agent.terminal_id);
    const focusedCompletion = this.observations.get(key)?.pendingCompletion;
    const version = typeof data.version === "string" ? data.version.match(/^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/) : undefined;
    const projectsAgentFocus = version && (Number(version[1]) > 0 || Number(version[2]) > 9 || (Number(version[2]) === 9 && Number(version[3]) >= 1));
    if (!projectsAgentFocus) {
      // v0.9.0 projects TabFocus to every attached shell client, while
      // AgentFocus only updates the server layout. Select its tab first.
      const response = parse((await this.request(session, ["tab", "focus", agent.tab_id])).stdout, "tab focus");
      if (!record(response.result) || response.result.type !== "tab_info" || !record(response.result.tab) ||
        response.result.tab.tab_id !== agent.tab_id || response.result.tab.workspace_id !== agent.workspace_id) {
        throw new Error("herdr focus: unexpected focused tab");
      }
    }
    const { stdout } = await this.request(session, ["agent", "focus", agent.pane_id]);
    const env = parse(stdout, "agent focus");
    if (!record(env.result) || env.result.type !== "agent_info" || !record(env.result.agent) || env.result.agent.terminal_id !== agent.terminal_id) {
      throw new Error("herdr focus: unexpected focused terminal");
    }
    const observation = this.observations.get(key);
    if (focusedCompletion && observation?.pendingCompletion === focusedCompletion) {
      observation.acknowledgedCompletion = focusedCompletion;
      observation.pendingCompletion = undefined;
      this.cached.set(session.socket_path, (this.cached.get(session.socket_path) ?? []).filter(i => i.entityKey !== key));
    }
  }
}
