import { test, after } from "node:test";
import { mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/core/services/store.js";
import type { AttentionItem } from "../src/core/types.js";

const sdkDirectory = mkdtempSync(join(tmpdir(), "muxboard-sdk-test-"));
copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "com.mrshu.muxboard.sdPlugin", "manifest.json"), join(sdkDirectory, "manifest.json"));
process.chdir(sdkDirectory);
after(() => rmSync(sdkDirectory, { recursive: true, force: true }));
const { AttentionKeyAction } = await import("../src/actions/attentionKey.js");

function harness(store: Store, focus: (item: AttentionItem) => Promise<void> = async () => {}) {
  const images: string[] = [];
  let ok = 0;
  let alerts = 0;
  const key = {
    id: "herdr-key", isKey: () => true, coordinates: { column: 0, row: 0 },
    async setImage(uri: string) { images.push(Buffer.from(uri.split(",")[1], "base64").toString("utf8")); },
    async showOk() { ok++; }, async showAlert() { alerts++; },
  };
  const action = new AttentionKeyAction({
    store, logger: { info() {}, warn() {}, error() {} },
    backends: { cmux: { focus }, orca: { focus }, herdr: { focus } },
  } as any);
  action.onWillAppear({ action: key } as any);
  return { action, key, images, get ok() { return ok; }, get alerts() { return alerts; } };
}

function agent(terminalId: string): AttentionItem {
  return {
    id: terminalId, source: "herdr", agent: "codex", workspaceId: "workspace",
    entityKey: `herdr:default:${terminalId}`, herdr: { session: "default", terminalId, paneId: "pane" },
    title: terminalId, reason: "blocked", activity: "waiting", createdAt: "2026-06-20T12:00:00Z",
  };
}

test("healthy Herdr keeps an empty Decisions board all-clear when cmux is offline", () => {
  const store = new Store();
  store.setSourceOffline("cmux", true);
  store.setHerdrActive(true);
  store.cycleView();
  const h = harness(store);
  assert.match(h.images.at(-1)!, /no decisions/);
  assert.doesNotMatch(h.images.at(-1)!, /offline/);
  store.setSourceOffline("herdr", true);
  assert.match(h.images.at(-1)!, /cmux \+ herdr/);
  assert.match(h.images.at(-1)!, /offline/);
});

test("offline label contains exactly active attention sources", () => {
  const store = new Store();
  store.setSourceOffline("cmux", true);
  const h = harness(store);
  assert.match(h.images.at(-1)!, />cmux</);
  store.setSourceOffline("herdr", true);
  assert.match(h.images.at(-1)!, />cmux</); // An inactive optional source is excluded.
  store.setHerdrActive(true);
  assert.match(h.images.at(-1)!, /cmux \+ herdr/);
  store.setOrcaActive(true);
  store.setSourceOffline("orca", true);
  assert.match(h.images.at(-1)!, /cmux \+ orca \+ herdr/);
});

test("Herdr tap focuses the native target and reports focus failure", async () => {
  const store = new Store();
  const item = agent("one");
  store.setAttention([item], false, "herdr");
  const focused: AttentionItem[] = [];
  const h = harness(store, async (target) => { focused.push(target); });
  await h.action.onKeyUp({ action: h.key } as any);
  assert.deepEqual(focused, [item]);
  const failed = harness(store, async () => { throw new Error("pane disappeared"); });
  await failed.action.onKeyUp({ action: failed.key } as any);
  assert.equal(failed.alerts, 1);
});

test("Herdr long-press snoozes one terminal and release never focuses its neighbor", async () => {
  const store = new Store();
  store.setAttention([agent("one"), agent("two")], false, "herdr");
  let focuses = 0;
  const h = harness(store, async () => { focuses++; });
  h.action.onKeyDown({ action: h.key } as any);
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(h.ok, 1);
  assert.deepEqual(store.getState().items.map((item) => item.id), ["two"]);
  await h.action.onKeyUp({ action: h.key } as any);
  assert.equal(focuses, 0);
});
