import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AttentionItem } from "../types.js";
import { type CommandRunner, execEnv, installDirs, resolveBin } from "../exec.js";
import { normalizeWorktrees, type RawOrcaTerminal } from "./normalize.js";

const execFileAsync = promisify(execFile);
const ORCA_DIRS = installDirs("/Applications/Orca.app/Contents/Resources/bin");

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
}
