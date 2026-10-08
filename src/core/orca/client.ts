import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { promisify } from "node:util";
import { delimiter, join } from "node:path";
import type { AttentionItem } from "../types.js";
import { type CommandRunner, execEnv, installDirs, resolveBin } from "../exec.js";
import { normalizeWorktrees, type RawOrcaTerminal } from "./normalize.js";

const execFileAsync = promisify(execFile);
const ORCA_DIRS = installDirs("/Applications/Orca.app/Contents/Resources/bin");

export type OrcaDeckAction = "shell" | "omp" | "claude" | "opencode" | "changes";

type AgentDeckAction = Exclude<OrcaDeckAction, "shell" | "changes">;

const AGENT_COMMANDS: Record<AgentDeckAction, { command: string; title: string }> = {
  omp: { command: "omp", title: "OMP" },
  claude: { command: "claude", title: "Claude" },
  opencode: { command: "opencode", title: "OpenCode" },
};

function agentInstallDirs(): string[] {
  const home = process.env.HOME;
  return [
    ...installDirs("/Applications/Orca.app/Contents/Resources/bin"),
    home ? join(home, ".opencode/bin") : "",
  ].filter(Boolean);
}

function executableAt(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExecutable(command: string): string | undefined {
  const dirs = [
    ...(process.env.PATH ?? "").split(delimiter),
    ...agentInstallDirs(),
  ];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (executableAt(candidate)) return candidate;
  }
  return undefined;
}

export function getAvailableDeckActions(): OrcaDeckAction[] {
  const actions: OrcaDeckAction[] = ["shell"];
  for (const action of ["omp", "claude", "opencode"] as const) {
    if (resolveExecutable(AGENT_COMMANDS[action].command)) actions.push(action);
  }
  actions.push("changes");
  return actions;
}

export function defaultOrcaBin(): string {
  return process.env.ORCA_CLI_COMMAND || (process.env.ORCA_DEV_REPO_ROOT ? "orca-dev" : process.platform === "linux" ? "orca-ide" : "orca");
}

const defaultRunner: CommandRunner = async (bin, args) => {
  const { stdout, stderr } = await execFileAsync(bin, args, {
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    env: execEnv(ORCA_DIRS),
  });
  return { stdout, stderr };
};

export interface OrcaClientOptions {
  bin?: string;
  runner?: CommandRunner;
  now?: () => number;
}

interface OrcaEnvelope<T> {
  ok?: unknown;
  result?: T;
  error?: { code?: unknown; message?: unknown };
}

function requireOk<T>(stdout: string, what: string): OrcaEnvelope<T> {
  let env: OrcaEnvelope<T>;
  try {
    env = JSON.parse(stdout) as OrcaEnvelope<T>;
  } catch {
    throw new Error(`orca ${what}: non-JSON response`);
  }
  if (!env || typeof env !== "object" || env.ok !== true) {
    const detail = env?.error ? `${String(env.error.code ?? "")} ${String(env.error.message ?? "")}`.trim() : "ok:false";
    throw new Error(`orca ${what} failed: ${detail}`);
  }
  return env;
}

function unwrap<T>(stdout: string, what: string): T {
  const env = requireOk<T>(stdout, what);
  if (env.result == null) throw new Error(`orca ${what}: missing result`);
  return env.result;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function requireCreatedTerminal(stdout: string, what: string): void {
  const result = unwrap<unknown>(stdout, what);
  if (!result || typeof result !== "object" || !("terminal" in result)) {
    throw new Error(`orca ${what}: missing created terminal`);
  }
  const terminal = result.terminal;
  if (!terminal || typeof terminal !== "object") {
    throw new Error(`orca ${what}: missing created terminal`);
  }
}

export class OrcaClient {
  private readonly bin: string;
  private readonly runner: CommandRunner;
  private readonly now: () => number;

  constructor(opts: OrcaClientOptions = {}) {
    this.bin = resolveBin(opts.bin ?? defaultOrcaBin(), ORCA_DIRS);
    this.runner = opts.runner ?? defaultRunner;
    this.now = opts.now ?? Date.now;
  }

  async listAttention(): Promise<AttentionItem[]> {
    const [ps, list] = await Promise.all([
      this.runner(this.bin, ["worktree", "ps", "--json"]),
      this.runner(this.bin, ["terminal", "list", "--json"]),
    ]);
    const { worktrees } = unwrap<{ worktrees?: unknown }>(ps.stdout, "worktree ps");
    const { terminals } = unwrap<{ terminals?: unknown }>(list.stdout, "terminal list");
    if (!Array.isArray(worktrees)) throw new Error("orca worktree ps: worktrees is not an array");
    if (!Array.isArray(terminals)) throw new Error("orca terminal list: terminals is not an array");
    return normalizeWorktrees(worktrees, new Date(this.now()).toISOString(), terminals);
  }

  async reachable(): Promise<boolean> {
    try {
      const { stdout } = await this.runner(this.bin, ["status", "--json"]);
      return unwrap<{ runtime?: { reachable?: unknown } }>(stdout, "status").runtime?.reachable === true;
    } catch {
      return false;
    }
  }

  /** Never substitute a newer neighboring terminal for the pane on the pressed key. */
  async focus(item: AttentionItem): Promise<void> {
    const handle = item.orca?.terminalHandle;
    if (!handle) throw new Error(`no terminal identity for ${item.id}`);
    const { stdout } = await this.runner(this.bin, ["terminal", "list", "--json"]);
    const { terminals } = unwrap<{ terminals?: RawOrcaTerminal[] }>(stdout, "terminal list");
    if (!Array.isArray(terminals)) throw new Error("orca terminal list: terminals is not an array");
    const live = terminals.find(t => t && t.handle === handle && t.connected === true && t.worktreeId === item.workspaceId);
    if (!live || (item.orca?.paneKey && `${live.tabId}:${live.leafId}` !== item.orca.paneKey)) {
      throw new Error(`terminal closed or replaced: ${handle}`);
    }
    const switched = await this.runner(this.bin, ["terminal", "switch", "--terminal", handle, "--json"]);
    requireOk(switched.stdout, "terminal switch");
  }

  async runDeckAction(action: OrcaDeckAction, item: AttentionItem): Promise<void> {
    const agent = action === "shell" || action === "changes" ? undefined : AGENT_COMMANDS[action];
    const command = agent && resolveExecutable(agent.command);
    if (agent && !command) throw new Error(`orca deck action ${action}: command unavailable`);

    const workspace = item.workspaceId;
    const handle = item.orca?.terminalHandle;
    const paneKey = item.orca?.paneKey;
    if (!workspace.includes("::")) throw new Error(`orca deck action ${action}: floating terminal has no worktree`);
    if (!handle || !paneKey) throw new Error(`orca deck action ${action}: no terminal identity for ${item.id}`);

    const { stdout } = await this.runner(this.bin, ["terminal", "list", "--json"]);
    const { terminals } = unwrap<{ terminals?: RawOrcaTerminal[] }>(stdout, "terminal list");
    if (!Array.isArray(terminals)) throw new Error("orca terminal list: terminals is not an array");
    const live = terminals.find(t => {
      if (!t || t.connected !== true || t.handle !== handle || t.worktreeId !== workspace) return false;
      if (typeof t.tabId !== "string" || typeof t.leafId !== "string") return false;
      return `${t.tabId}:${t.leafId}` === paneKey;
    });
    if (!live) throw new Error(`terminal closed or replaced: ${handle}`);

    const worktree = `id:${workspace}`;
    if (action === "changes") {
      const result = await this.runner(this.bin, ["file", "open-changed", "--worktree", worktree, "--mode", "diff", "--json"]);
      unwrap(result.stdout, "file open-changed");
      return;
    }

    const args = ["terminal", "create", "--worktree", worktree];
    if (agent && command) args.push("--command", shellQuote(command));
    const title = action === "shell" ? "Shell" : agent?.title;
    if (!title) throw new Error(`orca deck action ${action}: missing title`);
    args.push("--title", title, "--focus", "--json");
    const result = await this.runner(this.bin, args);
    requireCreatedTerminal(result.stdout, "terminal create");
  }
}
