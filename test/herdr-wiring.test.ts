import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig } from "../src/config.js";
import { makeHerdrBackend } from "../src/runtime.js";
import type { HerdrClient } from "../src/core/herdr/client.js";
import type { AttentionItem } from "../src/core/types.js";

const logger = { info() {}, warn() {}, error() {} };
const item: AttentionItem = {
  id: "terminal", source: "herdr", agent: "codex", workspaceId: "w1",
  title: "test", activity: "waiting", reason: "finished", createdAt: "2026-10-02T12:00:00Z",
  herdr: { session: "test", terminalId: "terminal", paneId: "w1:p1" },
};

test("Herdr settings retain defaults and bound local and remote polling", () => {
  const config = resolveConfig({
    herdrBin: " ", herdrPollMs: 1, herdrMachinePollMs: 1e9,
    herdrSessions: [" work ", "", 42 as unknown as string],
    herdrMachines: [" profile-id "], herdrIncludeMachines: false,
    enableHerdr: false,
  });
  assert.equal(config.herdrBin, "herdr");
  assert.equal(config.herdrPollMs, 500);
  assert.equal(config.herdrMachinePollMs, 600_000);
  assert.deepEqual(config.herdrSessions, ["work"]);
  assert.deepEqual(config.herdrMachines, ["profile-id"]);
  assert.equal(config.herdrIncludeMachines, false);
  assert.equal(config.enableHerdr, false);
  assert.equal(resolveConfig().enableHerdr, "auto");
  assert.equal(resolveConfig().herdrIncludeMachines, true);
});

test("Herdr settings reject malformed persisted values without enabling excessive polls", () => {
  const config = resolveConfig({
    herdrPollMs: NaN, herdrMachinePollMs: Infinity,
    enableHerdr: "yes" as unknown as boolean,
    herdrIncludeMachines: "false" as unknown as boolean,
    herdrSessions: {} as unknown as string[],
  });
  assert.equal(config.herdrPollMs, 1500);
  assert.equal(config.herdrMachinePollMs, 15000);
  assert.equal(config.enableHerdr, "auto");
  assert.equal(config.herdrIncludeMachines, true);
  assert.deepEqual(config.herdrSessions, []);
});

test("Herdr backend reveals the existing host before acknowledging completion", async () => {
  const calls: string[] = [];
  const target = { session: "test", terminalId: "terminal", paneId: "w1:p1", socketPath: "/test.sock" };
  const client = {
    async resolveFocusTarget(selected: AttentionItem) { assert.equal(selected, item); calls.push("resolve"); return target; },
    async focus(selected: AttentionItem, expected: unknown) { assert.equal(selected, item); assert.equal(expected, target); calls.push("focus"); },
  } as unknown as HerdrClient;
  await makeHerdrBackend(client, logger, {
    async show(selected) { assert.equal(selected, target); calls.push("reveal"); },
  }).focus(item);
  assert.deepEqual(calls, ["resolve", "reveal", "focus"]);
});

test("failure to reveal an existing host preserves the pending completion", async () => {
  let focused = false;
  const client = {
    async resolveFocusTarget() { return { session: "test", terminalId: "terminal", paneId: "w1:p1", socketPath: "/test.sock" }; },
    async focus() { focused = true; },
  } as unknown as HerdrClient;
  await assert.rejects(makeHerdrBackend(client, logger, {
    async show() { throw Error("No existing Herdr client currently displays that machine"); },
  }).focus(item), /No existing Herdr client/);
  assert.equal(focused, false);
});
