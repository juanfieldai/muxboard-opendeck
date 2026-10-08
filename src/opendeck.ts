import WebSocket, { type RawData } from "ws";
import { DEFAULT_CONFIG, resolveConfig, type MuxboardConfig } from "./config.js";
import { assignSlots, isDecision, itemRank } from "./core/cmux/sort.js";
import { getAvailableDeckActions, OrcaClient, type OrcaDeckAction } from "./core/orca/client.js";
import { defaultStripSocketPath, N1StripClient } from "./core/n1Strip.js";
import { renderNeoPanel } from "./core/render/neoPanel.js";
import { escapeXml, fitText } from "./core/render/format.js";
import { renderEmptyKey, renderFilteredEmpty, renderKey, renderOverflow, renderPagerHome, renderSourceOffline } from "./core/render/keyRender.js";
import { type Logger, message as errorMessage } from "./core/services/logger.js";
import { OrcaService } from "./core/services/orcaService.js";
import { Store } from "./core/services/store.js";
import { attentionEntityKey, type AppState, type AttentionItem } from "./core/types.js";

const AGENT_ACTION = "com.juanfieldai.muxboard.agent";
const CONTROLS_ACTION = "com.juanfieldai.muxboard.controls";
const LCD_ACTION = "com.juanfieldai.muxboard.lcd";
const KEY_COUNT = 15;
const LONG_PRESS_MS = 600;
const SNOOZE_MS = 5 * 60 * 1000;

type JsonObject = Record<string, unknown>;
type Coordinates = { column: number; row: number };
type Page = "agents" | "actions";
type ActionId = "focus" | "refresh" | "back" | OrcaDeckAction;
type KeyPress =
  | { kind: "item"; item: AttentionItem }
  | { kind: "action"; action: ActionId; target: AttentionItem | null }
  | { kind: "pager" }
  | { kind: "empty" };
type Timer = NodeJS.Timeout;

interface LaunchOptions {
  port: number;
  pluginUUID: string;
  registerEvent: string;
}

interface KeySurface { coordinates: Coordinates }
type AuxiliaryControl = "a" | "b";
interface DeckAction {
  id: ActionId;
  label: string;
}

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

function defaultLogger(): Logger {
  return {
    info: (line) => console.info(`[muxboard] ${line}`),
    warn: (line) => console.warn(`[muxboard] ${line}`),
    error: (line) => console.error(`[muxboard] ${line}`),
  };
}

/** A compact, stable identity for selection across replacement polls. */
function itemKey(item: AttentionItem): string {
  return attentionEntityKey(item) || item.id;
}

function itemName(item: AttentionItem): string {
  return item.title || item.repo || item.workspaceId || item.id;
}

function itemState(item: AttentionItem): string {
  if (item.reason === "unknown") return "UNKNOWN";
  if (item.reason === "finished") return "DONE";
  if (item.reason === "failed") return "FAILED";
  if (item.reason === "blocked") return "BLOCKED";
  if (item.needsInput || isDecision(item)) return "NEEDS";
  return item.activity === "working" ? "RUNNING" : "IDLE";
}

function markSelected(svg: string): string {
  const end = svg.lastIndexOf("</svg>");
  if (end < 0) return svg;
  return `${svg.slice(0, end)}<rect x="3" y="3" width="138" height="138" fill="none" stroke="#ffffff" stroke-width="4"/></svg>`;
}

function actionTile(action: DeckAction, selected: boolean): string {
  const fit = fitText(action.label, 116, 68, 12, 23);
  const lineHeight = fit.fontSize * 1.14;
  const start = 64 - (fit.lines.length * lineHeight) / 2 + fit.fontSize * 0.8;
  const label = fit.lines.map((line, index) => `<text x="72" y="${(start + index * lineHeight).toFixed(1)}" font-size="${fit.fontSize}" font-weight="800" text-anchor="middle" fill="#f1f4f8">${escapeXml(line)}</text>`).join("");
  const stroke = selected ? "#ffffff" : "#303641";
  const width = selected ? 5 : 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="#111318"/><rect x="3" y="3" width="138" height="138" fill="none" stroke="${stroke}" stroke-width="${width}"/><g font-family="-apple-system, Helvetica, Arial, sans-serif">${label}</g></svg>`;
}

export class OpenDeckHost {
  private readonly store = new Store([], () => Date.now(), KEY_COUNT);
  private readonly keySurfaces = new Map<string, KeySurface>();
  private readonly auxiliaryControls = new Map<string, AuxiliaryControl>();
  private readonly encoderSurfaces = new Set<string>();
  /** LCD action contexts and the device each one is on. */
  private readonly lcdSurfaces = new Map<string, string | null>();
  private readonly keyPresses = new Map<string, KeyPress>();
  private readonly holdTimers = new Map<string, Timer>();
  private readonly held = new Set<string>();
  private readonly imageCache = new Map<string, string>();
  private readonly availableActions = new Set(getAvailableDeckActions());
  private socket: WebSocket | null = null;
  private service: OrcaService | null = null;
  private orca: OrcaClient | null = null;
  private config: MuxboardConfig = DEFAULT_CONFIG;
  private registered = false;
  private cleanedUp = false;
  private rendering = false;
  private page: Page = "agents";
  private selectedKey: string | null = null;
  /** Exact object captured when Actions is opened; never replaced by a poll. */
  private actionTarget: AttentionItem | null = null;
  private selectedAction: ActionId = "focus";

  private readonly strip: N1StripClient;

  constructor(private readonly launch: LaunchOptions, private readonly log: Logger = defaultLogger()) {
    this.strip = new N1StripClient(defaultStripSocketPath(), log);
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
      case "dialUp": break;
      case "didReceiveGlobalSettings": this.globalSettings(wire); break;
      default: break;
    }
  }

  private willAppear(wire: JsonObject): void {
    const context = stringValue(wire.context);
    const action = actionUuid(wire);
    if (!context || !action) return;
    const controller = asObject(wire.payload)?.controller ?? wire.controller;
    if (action === AGENT_ACTION) {
      this.keySurfaces.set(context, { coordinates: coordinatesFrom(wire) });
      this.renderKey(context);
    } else if (action === CONTROLS_ACTION) {
      const coordinates = coordinatesFrom(wire);
      if (controller === "Keypad" && coordinates.row === 5 && coordinates.column < 2) {
        this.auxiliaryControls.set(context, coordinates.column === 0 ? "a" : "b");
      } else if (controller === "Encoder" && coordinates.column === 0) {
        this.encoderSurfaces.add(context);
      }
    } else if (action === LCD_ACTION && controller === "Infobar" && coordinatesFrom(wire).column === 0) {
      this.lcdSurfaces.set(context, stringValue(wire.device));
      this.renderLcd(context);
    }
  }

  private willDisappear(wire: JsonObject): void {
    const context = stringValue(wire.context);
    if (!context) return;
    this.keySurfaces.delete(context);
    this.encoderSurfaces.delete(context);
    this.auxiliaryControls.delete(context);
    const lcdDevice = this.lcdSurfaces.get(context);
    if (lcdDevice) this.strip.release(lcdDevice);
    this.lcdSurfaces.delete(context);
    this.keyPresses.delete(context);
    this.releaseHold(context);
    this.imageCache.delete(context);
  }

  private keyDown(wire: JsonObject): void {
    const context = stringValue(wire.context);
    if (!context) return;
    const auxiliary = this.auxiliaryControls.get(context);
    if (auxiliary) {
      this.releaseHold(context);
      if (auxiliary === "a") void this.focusNextDecision(context);
      else {
        this.keyPresses.set(context, { kind: "empty" });
        this.armPageHold(context);
      }
      return;
    }
    const surface = this.keySurfaces.get(context);
    if (!surface) return;
    this.releaseHold(context);
    const slot = this.slot(surface.coordinates);
    const state = this.store.getState();
    if (slot < 0 || slot >= KEY_COUNT) {
      this.keyPresses.set(context, { kind: "empty" });
      return;
    }

    if (this.page === "actions") {
      const action = this.actionEntries()[slot];
      if (!action) {
        this.keyPresses.set(context, { kind: "empty" });
        return;
      }
      // Capture both at keyDown. A later poll or page navigation must never
      // redirect a key-up into a different command or terminal. The pressed
      // action also becomes the selected knob action immediately.
      this.selectedAction = action.id;
      this.keyPresses.set(context, { kind: "action", action: action.id, target: this.actionTarget });
      this.renderAll();
      this.armActionHold(context);
      return;
    }

    if (this.isPager(slot, state)) {
      this.keyPresses.set(context, { kind: "pager" });
      return;
    }
    const item = assignSlots(state.items, state.offset, KEY_COUNT)[slot] ?? null;
    this.keyPresses.set(context, item ? { kind: "item", item } : { kind: "empty" });
    if (item) {
      // A direct key press is also a selection change. Keep the selected
      // entity stable when Button B opens the worktree action page next.
      this.selectedKey = itemKey(item);
      this.renderAll();
      this.armItemHold(context, item);
    }
  }

  private async keyUp(wire: JsonObject): Promise<void> {
    const context = stringValue(wire.context);
    if (!context) return;
    const auxiliary = this.auxiliaryControls.get(context);
    if (auxiliary) {
      const pressed = this.keyPresses.delete(context);
      if (auxiliary === "b" && pressed && !this.releaseHold(context)) this.store.cycleView();
      return;
    }
    if (this.releaseHold(context)) {
      this.keyPresses.delete(context);
      return;
    }
    const press = this.keyPresses.get(context);
    this.keyPresses.delete(context);
    if (!press) return;
    if (press.kind === "pager") {
      this.selectNextPage();
      return;
    }
    if (press.kind === "action") {
      await this.runAction(press.action, press.target, context);
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
    if (!context || !this.encoderSurfaces.has(context)) return;
    const ticks = Math.trunc(numberValue(asObject(wire.payload)?.ticks, 0));
    if (ticks === 0) return;
    if (this.page === "actions") this.moveActionSelection(ticks);
    else this.moveAgentSelection(ticks);
  }

  private dialDown(wire: JsonObject): void {
    const context = stringValue(wire.context);
    if (!context || !this.encoderSurfaces.has(context)) return;
    const action: ActionId = this.page === "actions" ? this.selectedAction : "focus";
    const target = this.page === "actions" ? this.actionTarget : this.selectedItem();
    void this.runAction(action, target, context);
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
    if (this.rendering) return;
    this.rendering = true;
    try {
      if (this.page === "agents") this.reconcileAgentSelection();
      else this.reconcileActionSelection();
      for (const context of this.keySurfaces.keys()) this.renderKey(context);
      for (const context of this.lcdSurfaces.keys()) this.renderLcd(context);
    } finally {
      this.rendering = false;
    }
  }

  private renderKey(context: string): void {
    const surface = this.keySurfaces.get(context);
    if (!surface) return;
    const slot = this.slot(surface.coordinates);
    if (slot < 0 || slot >= KEY_COUNT) return;
    const state = this.store.getState();
    if (this.page === "actions") {
      const action = this.actionEntries()[slot];
      this.setImage(context, action ? actionTile(action, action.id === this.selectedAction) : renderEmptyKey(slot + 1));
      return;
    }

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
      if (item && itemKey(item) === this.selectedKey) svg = markSelected(svg);
    }
    this.setImage(context, svg);
  }

  private renderLcd(context: string): void {
    if (!this.lcdSurfaces.has(context)) return;
    const state = this.store.getState();
    const target = this.page === "actions" ? this.actionTarget : this.selectedItem();
    const action = this.page === "actions" ? this.selectedActionEntry() : undefined;
    const selectedIndex = target && this.page === "agents"
      ? state.items.findIndex((item) => itemKey(item) === itemKey(target))
      : -1;
    const selectedState = target
      ? selectedIndex >= 0
        ? `${selectedIndex + 1}/${state.items.length} ${itemState(target)}`
        : itemState(target)
      : undefined;
    const svg = renderNeoPanel({
      page: this.page,
      view: state.view === "decisions" ? "needs" : "all",
      count: state.items.length,
      needsCount: state.items.filter(isDecision).length,
      selectedName: target ? itemName(target) : undefined,
      selectedState,
      actionName: action?.label,
    });
    // OpenDeck's copy keeps the editor preview and is the fallback when no N1 strip socket exists.
    this.setImage(context, svg);
    const device = this.lcdSurfaces.get(context);
    if (device) this.strip.draw(device, svg);
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

  /** Actions do not have a hold command: a held key is swallowed. */
  private armActionHold(context: string): void {
    this.holdTimers.set(context, setTimeout(() => {
      this.holdTimers.delete(context);
      this.held.add(context);
    }, LONG_PRESS_MS));
  }

  private armPageHold(context: string): void {
    this.holdTimers.set(context, setTimeout(() => {
      this.holdTimers.delete(context);
      this.held.add(context);
      this.togglePage();
      this.send({ event: "showOk", context, payload: {} });
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

  private async focusNextDecision(context: string): Promise<void> {
    const items = this.store.getState().items;
    const decisions = items.filter(isDecision);
    if (decisions.length === 0) {
      this.alert(context);
      return;
    }
    if (this.page === "actions") {
      this.page = "agents";
      this.actionTarget = null;
      this.reconcileAgentSelection();
    }
    const current = this.selectedKey ? decisions.findIndex((item) => itemKey(item) === this.selectedKey) : -1;
    const next = decisions[(current + 1 + decisions.length) % decisions.length];
    this.selectedKey = itemKey(next);
    this.renderAll();
    if (!this.orca) return;
    try {
      await this.orca.focus(next);
    } catch (err) {
      this.log.error(`focus failed: ${errorMessage(err)}`);
      this.alert(context);
    }
  }

  private async runAction(action: ActionId, target: AttentionItem | null, context: string): Promise<void> {
    if (action === "back") {
      this.page = "agents";
      this.actionTarget = null;
      this.selectedAction = "focus";
      this.renderAll();
      return;
    }
    if (action === "refresh") {
      await this.refresh();
      return;
    }
    if (!target || !this.orca) {
      this.alert(context);
      return;
    }
    try {
      if (action === "focus") await this.orca.focus(target);
      else {
        if (!target.workspaceId.includes("::")) {
          this.alert(context);
          return;
        }
        await this.orca.runDeckAction(action, target);
      }
    } catch (err) {
      this.log.error(`action ${action} failed: ${errorMessage(err)}`);
      this.alert(context);
    }
  }

  private togglePage(): void {
    if (this.page === "agents") {
      this.actionTarget = this.selectedItem();
      this.page = "actions";
      this.selectedAction = this.actionEntries().some((entry) => entry.id === "focus") ? "focus" : this.actionEntries()[0]?.id ?? "back";
    } else {
      this.page = "agents";
      this.actionTarget = null;
      this.selectedAction = "focus";
    }
    this.renderAll();
  }

  private moveAgentSelection(delta: number): void {
    const items = this.store.getState().items;
    if (items.length === 0) return;
    this.reconcileAgentSelection();
    const index = Math.max(0, items.findIndex((item) => itemKey(item) === this.selectedKey));
    const next = ((index + delta) % items.length + items.length) % items.length;
    this.selectedKey = itemKey(items[next]);
    this.renderAll();
  }

  private moveActionSelection(delta: number): void {
    const entries = this.actionEntries();
    if (entries.length === 0) return;
    const index = Math.max(0, entries.findIndex((entry) => entry.id === this.selectedAction));
    this.selectedAction = entries[((index + delta) % entries.length + entries.length) % entries.length].id;
    this.renderAll();
  }

  /**
   * Overflow remains visible as a pager tile, but paging moves the stable
   * selection as well. That keeps the selected key on-screen instead of
   * letting reconciliation immediately snap a page change back into place.
   */
  private selectNextPage(): void {
    const state = this.store.getState();
    const items = state.items;
    if (items.length <= KEY_COUNT) return;
    const visible = KEY_COUNT - 1;
    const selected = this.selectedKey ? items.findIndex((item) => itemKey(item) === this.selectedKey) : -1;
    const current = selected >= 0 ? selected : state.offset;
    const next = current + visible < items.length ? current + visible : 0;
    this.selectedKey = itemKey(items[next]);
    this.renderAll();
  }

  private selectedItem(): AttentionItem | null {
    const items = this.store.getState().items;
    if (this.selectedKey) {
      const selected = items.find((item) => itemKey(item) === this.selectedKey);
      if (selected) return selected;
    }
    return items[0] ?? null;
  }

  private reconcileAgentSelection(): void {
    const items = this.store.getState().items;
    if (items.length === 0) {
      this.selectedKey = null;
      return;
    }
    let index = this.selectedKey ? items.findIndex((item) => itemKey(item) === this.selectedKey) : -1;
    if (index < 0) {
      index = Math.min(this.store.getState().offset, items.length - 1);
      this.selectedKey = itemKey(items[index]);
    }
    this.keepSelectionVisible(index);
  }

  private keepSelectionVisible(index: number): void {
    const state = this.store.getState();
    const visible = state.items.length > KEY_COUNT ? KEY_COUNT - 1 : KEY_COUNT;
    const maxOffset = Math.max(0, state.items.length - 1);
    let offset = state.offset;
    if (index < offset) offset = index;
    else if (index >= offset + visible) offset = index - visible + 1;
    offset = Math.max(0, Math.min(maxOffset, offset));
    if (offset !== state.offset) this.store.scrollBy(offset - state.offset);
  }

  private reconcileActionSelection(): void {
    const entries = this.actionEntries();
    if (entries.length > 0 && !entries.some((entry) => entry.id === this.selectedAction)) this.selectedAction = entries[0].id;
  }

  private actionEntries(): DeckAction[] {
    const target = this.actionTarget;
    const entries: DeckAction[] = [];
    if (target) entries.push({ id: "focus", label: "Focus selected" });
    const available = this.availableActions;
    if (target && target.workspaceId.includes("::")) {
      for (const id of ["shell", "omp", "claude", "opencode", "changes"] as OrcaDeckAction[]) {
        if (available.has(id)) entries.push({ id, label: id === "changes" ? "Show changes" : id === "opencode" ? "OpenCode" : id.toUpperCase() });
      }
    }
    entries.push({ id: "refresh", label: "Refresh" }, { id: "back", label: "Back" });
    return entries;
  }

  private selectedActionEntry(): DeckAction | undefined {
    return this.actionEntries().find((entry) => entry.id === this.selectedAction);
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
    this.strip.close();
  }

  private slot(coordinates: Coordinates): number {
    return coordinates.row * 3 + coordinates.column;
  }

  private isPager(slot: number, state: Readonly<AppState>): boolean {
    return this.page === "agents" && slot === KEY_COUNT - 1 && state.items.length > KEY_COUNT;
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
