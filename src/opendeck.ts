import WebSocket, { type RawData } from "ws";
import { DEFAULT_CONFIG, resolveConfig, type MuxboardConfig } from "./config.js";
import { assignSlots, itemRank } from "./core/cmux/sort.js";
import { OrcaClient } from "./core/orca/client.js";
import { renderEmptyKey, renderFilteredEmpty, renderKey, renderOverflow, renderPagerHome, renderSourceOffline } from "./core/render/keyRender.js";
import { type Logger, message as errorMessage } from "./core/services/logger.js";
import { OrcaService } from "./core/services/orcaService.js";
import { Store } from "./core/services/store.js";
import type { AppState, AttentionItem } from "./core/types.js";

const AGENT_ACTION = "com.juanfieldai.muxboard.agent";
const CONTROLS_ACTION = "com.juanfieldai.muxboard.controls";
const KEY_COUNT = 15;
const LONG_PRESS_MS = 600;
const SNOOZE_MS = 5 * 60 * 1000;

type JsonObject = Record<string, unknown>;
type Coordinates = { column: number; row: number };
type KeyPress = { kind: "item"; item: AttentionItem } | { kind: "pager" } | { kind: "empty" };
type Timer = NodeJS.Timeout;

interface LaunchOptions {
  port: number;
  pluginUUID: string;
  registerEvent: string;
}

interface KeySurface { coordinates: Coordinates }
interface EncoderSurface { index: number }

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function coordinatesFrom(wire: JsonObject): Coordinates {
  const payload = asObject(wire.payload);
  const coordinates = asObject(payload?.coordinates) ?? asObject(wire.coordinates);
  return {
    column: Math.max(0, Math.floor(numberValue(coordinates?.column, 0))),
    row: Math.max(0, Math.floor(numberValue(coordinates?.row, 0))),
  };
}

function actionUuid(wire: JsonObject): string | null {
  const action = typeof wire.action === "string" ? wire.action : asObject(wire.action)?.uuid;
  return stringValue(action);
}

function dataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function overflowAccent(items: AttentionItem[]): string {
  const colors: Record<number, string> = { 0: "#ff4d4f", 1: "#ffb02e", 2: "#38bdf8", 3: "#e0852b" };
  return colors[Math.min(...items.map(itemRank))] ?? "#7d8794";
}

function encoderSvg(index: number, state: Readonly<AppState>): string {
  const labels = [
    ["AGENTS", state.filter.toUpperCase()],
    ["DECISIONS", state.view === "decisions" ? "ON" : "OFF"],
    ["SCROLL", "↕"],
  ] as const;
  const [label, value] = labels[index] ?? labels[0];
  const accent = index === 1 && state.view === "decisions" ? "#38bdf8" : "#7b86c4";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" rx="18" fill="#0d0e10"/><rect x="3" y="3" width="138" height="138" rx="16" fill="none" stroke="#2c3038" stroke-width="2"/><g font-family="-apple-system, Helvetica, Arial, sans-serif" text-anchor="middle"><text x="72" y="52" font-size="14" font-weight="800" letter-spacing="1" fill="#9aa0aa">${label}</text><text x="72" y="101" font-size="31" font-weight="800" fill="${accent}">${value}</text></g></svg>`;
}

function defaultLogger(): Logger {
  return {
    info: (line) => console.info(`[muxboard] ${line}`),
    warn: (line) => console.warn(`[muxboard] ${line}`),
    error: (line) => console.error(`[muxboard] ${line}`),
  };
}

export class OpenDeckHost {
  private readonly store = new Store([], () => Date.now(), KEY_COUNT);
  private readonly keySurfaces = new Map<string, KeySurface>();
  private readonly encoderSurfaces = new Map<string, EncoderSurface>();
  private readonly keyPresses = new Map<string, KeyPress>();
  private readonly holdTimers = new Map<string, Timer>();
  private readonly held = new Set<string>();
  private readonly imageCache = new Map<string, string>();
  private socket: WebSocket | null = null;
  private service: OrcaService | null = null;
  private orca: OrcaClient | null = null;
  private config: MuxboardConfig = DEFAULT_CONFIG;
  private registered = false;
  private cleanedUp = false;

  constructor(private readonly launch: LaunchOptions, private readonly log: Logger = defaultLogger()) {
    this.store.subscribe(() => this.renderAll());
  }

  connect(): void {
    if (this.socket) throw new Error("OpenDeck host is already connected");
    const socket = new WebSocket(`ws://127.0.0.1:${this.launch.port}`);
    this.socket = socket;
    socket.once("open", () => this.register());
    socket.on("message", (raw) => this.receive(raw));
    socket.once("error", (err) => this.log.error(`websocket error: ${errorMessage(err)}`));
    socket.once("close", () => {
      this.log.warn("OpenDeck websocket closed");
      this.cleanup();
    });
  }

  shutdown(): void {
    this.cleanup();
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close();
    this.socket = null;
  }

  private register(): void {
    this.registered = true;
    this.send({ event: this.launch.registerEvent, uuid: this.launch.pluginUUID });
    this.send({ event: "getGlobalSettings", context: this.launch.pluginUUID });
    this.startService(DEFAULT_CONFIG);
    this.log.info(`registered ${this.launch.pluginUUID}`);
  }

  private receive(raw: RawData): void {
    let wire: JsonObject;
    try {
      const parsed: unknown = JSON.parse(raw.toString());
      const object = asObject(parsed);
      if (!object) throw new Error("message is not an object");
      wire = object;
    } catch (err) {
      this.log.error(`invalid websocket message: ${errorMessage(err)}`);
      return;
    }
    const event = stringValue(wire.event);
    if (!event) return;
    switch (event) {
      case "willAppear": this.willAppear(wire); break;
      case "willDisappear": this.willDisappear(wire); break;
      case "keyDown": this.keyDown(wire); break;
      case "keyUp": void this.keyUp(wire); break;
      case "dialRotate": this.dialRotate(wire); break;
      case "dialDown": this.dialDown(wire); break;
      case "dialUp": this.dialUp(wire); break;
      case "didReceiveGlobalSettings": this.globalSettings(wire); break;
      default: break;
    }
  }

  private willAppear(wire: JsonObject): void {
    const context = stringValue(wire.context);
    const action = actionUuid(wire);
    if (!context || !action) return;
    if (action === AGENT_ACTION) {
      this.keySurfaces.set(context, { coordinates: coordinatesFrom(wire) });
      this.renderKey(context);
    } else if (action === CONTROLS_ACTION) {
      this.encoderSurfaces.set(context, { index: this.encoderIndex(coordinatesFrom(wire)) });
      this.renderEncoder(context);
    }
  }

  private willDisappear(wire: JsonObject): void {
    const context = stringValue(wire.context);
    if (!context) return;
    this.keySurfaces.delete(context);
    this.encoderSurfaces.delete(context);
    this.keyPresses.delete(context);
    this.releaseHold(context);
    this.imageCache.delete(context);
  }

  private keyDown(wire: JsonObject): void {
    const context = stringValue(wire.context);
    const surface = context ? this.keySurfaces.get(context) : undefined;
    if (!context || !surface) return;
    this.releaseHold(context);
    const slot = this.slot(surface.coordinates);
    const state = this.store.getState();
    if (slot < 0 || slot >= KEY_COUNT) {
      this.keyPresses.set(context, { kind: "empty" });
      return;
    }
    if (this.isPager(slot, state)) {
      this.keyPresses.set(context, { kind: "pager" });
      return;
    }
    const item = assignSlots(state.items, state.offset, KEY_COUNT)[slot] ?? null;
    this.keyPresses.set(context, item ? { kind: "item", item } : { kind: "empty" });
    if (item) this.armItemHold(context, item);
  }

  private async keyUp(wire: JsonObject): Promise<void> {
    const context = stringValue(wire.context);
    if (!context) return;
    if (this.releaseHold(context)) {
      this.keyPresses.delete(context);
      return;
    }
    const press = this.keyPresses.get(context);
    this.keyPresses.delete(context);
    if (!press) return;
    if (press.kind === "pager") {
      const state = this.store.getState();
      if (state.items.length > state.offset + KEY_COUNT - 1) this.store.pageForward();
      else this.store.resetOffset();
      return;
    }
    if (press.kind !== "item" || !this.orca) return;
    try {
      await this.orca.focus(press.item);
    } catch (err) {
      this.log.error(`focus failed: ${errorMessage(err)}`);
      this.alert(context);
    }
  }

  private dialRotate(wire: JsonObject): void {
    const context = stringValue(wire.context);
    const surface = context ? this.encoderSurfaces.get(context) : undefined;
    if (!surface || (surface.index !== 0 && surface.index !== 2)) return;
    const ticks = Math.trunc(numberValue(asObject(wire.payload)?.ticks, 0));
    if (ticks === 0) return;
    if (surface.index === 0) this.store.cycleFilter(ticks >= 0 ? 1 : -1);
    else this.store.scrollBy(ticks);
  }

  private dialDown(wire: JsonObject): void {
    const context = stringValue(wire.context);
    const surface = context ? this.encoderSurfaces.get(context) : undefined;
    if (!context || !surface) return;
    this.releaseHold(context);
    if (surface.index === 0) this.store.cycleFilter(1);
    else if (surface.index === 1) this.store.cycleView();
    else if (surface.index === 2) this.armEncoderHold(context);
  }

  private dialUp(wire: JsonObject): void {
    const context = stringValue(wire.context);
    const surface = context ? this.encoderSurfaces.get(context) : undefined;
    if (!context || !surface || surface.index !== 2) return;
    if (!this.releaseHold(context)) {
      if (this.store.getState().view === "decisions") this.store.cycleView();
      this.store.resetFilters();
      this.store.resetOffset();
    }
  }

  private globalSettings(wire: JsonObject): void {
    if (!this.registered) return;
    const settings = asObject(asObject(wire.payload)?.settings);
    this.config = resolveConfig(settings as Partial<MuxboardConfig> | null);
    this.startService(this.config);
  }

  private startService(config: MuxboardConfig): void {
    if (!this.registered) return;
    this.service?.stop();
    if (config.enableOrca === false) {
      this.orca = null;
      this.service = null;
      this.store.setOrcaActive(false);
      return;
    }
    this.orca = new OrcaClient({ bin: config.orcaBin });
    this.service = new OrcaService({ client: this.orca, store: this.store, pollMs: config.orcaPollMs, logger: this.log });
    this.store.setOrcaActive(true);
    this.service.start();
    this.log.info(`Orca polling started with ${config.orcaBin}`);
  }
  private renderAll(): void {
    for (const context of this.keySurfaces.keys()) this.renderKey(context);
    for (const context of this.encoderSurfaces.keys()) this.renderEncoder(context);
  }

  private renderKey(context: string): void {
    const surface = this.keySurfaces.get(context);
    if (!surface) return;
    const slot = this.slot(surface.coordinates);
    if (slot < 0 || slot >= KEY_COUNT) return;
    const state = this.store.getState();
    let svg: string;
    if (state.orcaOffline && state.items.length === 0 && slot === 0) {
      svg = renderSourceOffline("orca");
    } else if (state.filter !== "all" && state.items.length === 0 && slot === 0) {
      svg = renderFilteredEmpty(state.filter, state.view === "decisions");
    } else if (this.isPager(slot, state)) {
      const hidden = state.items.slice(state.offset + KEY_COUNT - 1);
      svg = hidden.length > 0 ? renderOverflow(hidden.length, overflowAccent(hidden)) : renderPagerHome();
    } else {
      const item = assignSlots(state.items, state.offset, KEY_COUNT)[slot] ?? null;
      svg = item
        ? renderKey(item, { nowMs: Date.now(), slotNumber: state.offset > 0 ? state.offset + slot + 1 : undefined, viewBadge: state.orcaOffline ? "OFF" : state.view === "decisions" ? "DEC" : undefined })
        : renderEmptyKey(slot + 1);
    }
    this.setImage(context, svg);
  }

  private renderEncoder(context: string): void {
    const surface = this.encoderSurfaces.get(context);
    if (surface) this.setImage(context, encoderSvg(surface.index, this.store.getState()));
  }

  private setImage(context: string, svg: string): void {
    if (this.imageCache.get(context) === svg) return;
    this.imageCache.set(context, svg);
    this.send({ event: "setImage", context, payload: { image: dataUri(svg) } });
  }

  private send(payload: JsonObject): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    try { this.socket.send(JSON.stringify(payload)); }
    catch (err) { this.log.error(`websocket send failed: ${errorMessage(err)}`); }
  }

  private alert(context: string): void {
    this.send({ event: "showAlert", context, payload: {} });
  }

  private armItemHold(context: string, item: AttentionItem): void {
    this.holdTimers.set(context, setTimeout(() => {
      this.holdTimers.delete(context);
      this.held.add(context);
      this.store.snoozeItem(item, SNOOZE_MS);
      this.send({ event: "showOk", context, payload: {} });
    }, LONG_PRESS_MS));
  }

  private armEncoderHold(context: string): void {
    this.holdTimers.set(context, setTimeout(() => {
      this.holdTimers.delete(context);
      this.held.add(context);
      void this.refresh();
    }, LONG_PRESS_MS));
  }

  private releaseHold(context: string): boolean {
    const timer = this.holdTimers.get(context);
    if (timer) {
      clearTimeout(timer);
      this.holdTimers.delete(context);
    }
    return this.held.delete(context);
  }

  private async refresh(): Promise<void> {
    if (!this.service) return;
    try { await this.service.poll(); }
    catch (err) { this.log.error(`refresh failed: ${errorMessage(err)}`); }
  }

  private cleanup(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    this.service?.stop();
    this.service = null;
    this.orca = null;
    for (const timer of this.holdTimers.values()) clearTimeout(timer);
    this.holdTimers.clear();
    this.held.clear();
    this.keyPresses.clear();
  }

  private slot(coordinates: Coordinates): number {
    return coordinates.row * 3 + coordinates.column;
  }

  private encoderIndex(coordinates: Coordinates): number {
    return Math.max(0, Math.min(2, coordinates.column));
  }

  private isPager(slot: number, state: Readonly<AppState>): boolean {
    return slot === KEY_COUNT - 1 && state.items.length > KEY_COUNT;
  }
}

function parseLaunchOptions(argv: string[]): LaunchOptions {
  const read = (flag: string): string => {
    const index = argv.indexOf(flag);
    const value = index >= 0 ? argv[index + 1] : undefined;
    if (!value || value.startsWith("-")) throw new Error(`missing ${flag}`);
    return value;
  };
  const port = Number.parseInt(read("-port"), 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("invalid -port");
  return { port, pluginUUID: read("-pluginUUID"), registerEvent: read("-registerEvent") };
}

export function main(argv = process.argv.slice(2)): void {
  let options: LaunchOptions;
  try { options = parseLaunchOptions(argv); }
  catch (err) { console.error(`[muxboard] ${errorMessage(err)}`); process.exitCode = 2; return; }
  const host = new OpenDeckHost(options);
  const stop = (): void => { host.shutdown(); process.exit(0); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  host.connect();
}

if (process.argv[1]?.endsWith("opendeck.cjs") || process.argv[1]?.endsWith("opendeck.js")) main();
