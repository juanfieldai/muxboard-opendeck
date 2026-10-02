import type { HerdrClient } from "../herdr/client.js";
import type { AttentionItem } from "../types.js";
import { AttentionPoller, type AttentionPollerOptions } from "./attentionPoller.js";
import { silentLogger, type Logger } from "./logger.js";

export interface HerdrServiceOptions extends AttentionPollerOptions { client: HerdrClient }

export class HerdrService extends AttentionPoller {
  private readonly client: HerdrClient;
  private readonly healthLog: Logger;
  private lastPartialErrors = "";
  constructor(opts: HerdrServiceOptions) {
    super("herdr", opts);
    this.client = opts.client;
    this.healthLog = opts.logger ?? silentLogger;
  }
  protected async fetch(): Promise<AttentionItem[]> {
    try {
      const rows = await this.client.listAttention();
      const errors = this.client.health.errors.map(e => `${e.session}: ${e.message}`).sort().join("; ");
      if (errors && errors !== this.lastPartialErrors) this.healthLog.warn(`herdr partially unavailable; retaining last-good rows: ${errors}`);
      if (!errors && this.lastPartialErrors) this.healthLog.info(this.client.hasTargets
        ? "herdr targets recovered; all discovered feeds are healthy"
        : "herdr unavailable targets removed");
      this.lastPartialErrors = errors;
      return rows;
    } catch (err) {
      // Discovery may have removed stopped sessions before all remaining reads
      // failed. Publish the client's retained rows so stopped sessions vanish.
      if (this.client.health.running > 0 && this.client.health.successful === 0) {
        this.store.setAttention(this.client.lastGoodItems, this.store.getState().herdrOffline, "herdr");
      }
      throw err;
    }
  }
  override async poll(): Promise<void> {
    await super.poll();
    if (this.client.noTargets) this.store.setSourceOffline("herdr", true);
  }
  async refresh(): Promise<void> {
    this.client.invalidateRemoteCache();
    await this.poll();
  }
}
