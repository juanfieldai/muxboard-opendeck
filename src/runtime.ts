import { execFile } from "node:child_process";
import type { MuxboardConfig } from "./config.js";
import { type Logger, message } from "./core/services/logger.js";
import type { Store } from "./core/services/store.js";
import type { CmuxClient } from "./core/cmux/client.js";
import type { CmuxService } from "./core/services/cmuxService.js";
import type { CodexbarService } from "./core/services/codexbarService.js";
import type { AttentionItem, AttentionSource } from "./core/types.js";
import type { OrcaClient } from "./core/orca/client.js";
import type { OrcaService } from "./core/services/orcaService.js";
import type { HerdrClient } from "./core/herdr/client.js";
import type { HerdrService } from "./core/services/herdrService.js";
import { HerdrReveal } from "./core/herdr/reveal.js";

/**
 * Shared runtime handed to the Stream Deck actions: the store they render from,
 * the poll services they drive, the per-source focus backends, and config. Constructed once in plugin.ts.
 */
export interface Runtime {
  config: MuxboardConfig;
  store: Store;
  cmuxService: CmuxService;
  codexbarService: CodexbarService;
  /** Orca poller; force-refresh triggers it when Orca is active. */
  orcaService: OrcaService;
  herdrService: HerdrService;
  logger: Logger;
  /** Per-source focus backends, resolved by item.source. */
  backends: Record<AttentionSource, AttentionBackend>;
}

/** Per-source focus capability resolved by item.source. */
export interface AttentionBackend {
  /** Bring the source app forward and jump to the item's surface. */
  focus(item: AttentionItem): Promise<void>;
}

/** Bring an app to the foreground on macOS (best-effort). */
function bringAppToFront(app: string, logger: Logger): void {
  execFile("open", ["-a", app], (err) => {
    if (err) logger.warn(`bring ${app} to front failed: ${err.message}`);
  });
}

export function makeCmuxBackend(cmux: CmuxClient, logger: Logger): AttentionBackend {
  return {
    async focus(item) {
      bringAppToFront("cmux", logger);
      if (item.synthetic) {
        await cmux.selectWorkspace(item.workspaceId);
        return;
      }
      try {
        await cmux.openNotification(item.id);
      } catch (err) {
        logger.warn(`open-notification failed, falling back: ${message(err)}`);
        await cmux.selectWorkspace(item.workspaceId);
      }
    },
  };
}

export function makeOrcaBackend(orca: OrcaClient, logger: Logger): AttentionBackend {
  return {
    async focus(item) {
      bringAppToFront("Orca", logger);
      await orca.focus(item);
    },
  };
}

/** Reveal the existing client before focus acknowledges the selected work. */
export function makeHerdrBackend(
  herdr: HerdrClient,
  logger: Logger,
  reveal: Pick<HerdrReveal, "show"> = new HerdrReveal(),
): AttentionBackend {
  return {
    async focus(item) {
      const target = await herdr.resolveFocusTarget(item);
      try {
        await reveal.show(target);
      } catch (err) {
        logger.warn(`reveal existing Herdr client failed: ${message(err)}`);
        throw err;
      }
      await herdr.focus(item, target);
    },
  };
}
