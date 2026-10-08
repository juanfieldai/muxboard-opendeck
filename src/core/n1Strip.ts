import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { type Logger, message as errorMessage } from "./services/logger.js";

/** Socket served by the opendeck-mirabox-n1 driver for drawing its LCD strip at native 450×85. */
export function defaultStripSocketPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, "opendeck-mirabox-n1", "strip.sock") : undefined;
}

const drawRequest = (device: string, svg: string): string =>
  `${JSON.stringify({ event: "drawStrip", device, image: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` })}\n`;

/**
 * Draws the dashboard straight onto the N1 strip, bypassing OpenDeck's 248×58 Infobar raster.
 * Callers still send the same image through setImage, so the editor preview and drivers without
 * this socket keep working; the driver shows OpenDeck's frame again once the strip is released
 * or this client disconnects. The last frame per device is resent after the driver restarts.
 */
export class N1StripClient {
  private socket: net.Socket | null = null;
  private readonly frames = new Map<string, string>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastProblem: string | null = null;
  private closed = false;

  constructor(
    private readonly socketPath: string | undefined,
    private readonly log: Logger,
    private readonly reconnectMs = 2000,
  ) {}

  draw(device: string, svg: string): void {
    if (this.frames.get(device) === svg) return;
    this.frames.set(device, svg);
    if (this.socket) this.socket.write(drawRequest(device, svg));
    else this.connect();
  }

  release(device: string): void {
    if (!this.frames.delete(device)) return;
    this.socket?.write(`${JSON.stringify({ event: "releaseStrip", device })}\n`);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.reconnectTimer ?? undefined);
    this.reconnectTimer = null;
    this.frames.clear();
    this.socket?.end();
    this.socket = null;
  }

  private connect(): void {
    if (this.closed || this.socket || this.frames.size === 0 || !this.socketPath) return;
    if (!existsSync(this.socketPath)) {
      this.problem(`N1 strip socket ${this.socketPath} not found; using OpenDeck's Infobar image`);
      this.scheduleReconnect();
      return;
    }
    const socket = net.createConnection(this.socketPath);
    this.socket = socket;
    // Queued until connected; the driver lost any previous frames if it restarted.
    for (const [device, svg] of this.frames) socket.write(drawRequest(device, svg));
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      this.lastProblem = null;
      this.log.info(`drawing the N1 strip directly via ${this.socketPath}`);
    });
    socket.on("data", (chunk: string) => {
      pending += chunk;
      for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
        this.reply(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
    });
    socket.on("error", (err) => this.problem(`N1 strip socket: ${errorMessage(err)}`));
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.scheduleReconnect();
    });
  }

  private reply(line: string): void {
    try {
      const reply = JSON.parse(line) as { ok?: boolean; error?: string };
      if (reply.ok === false) this.problem(`N1 strip rejected a frame: ${reply.error ?? "unknown error"}`);
    } catch {
      this.problem(`N1 strip sent an invalid reply: ${line}`);
    }
  }

  /** Logs each distinct problem once, so a missing driver does not flood the log. */
  private problem(text: string): void {
    if (text === this.lastProblem) return;
    this.lastProblem = text;
    this.log.warn(text);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer || this.frames.size === 0) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectMs);
    this.reconnectTimer.unref();
  }
}
