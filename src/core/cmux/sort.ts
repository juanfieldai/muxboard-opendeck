import type { AgentFilter, AttentionItem } from "../types.js";
import { attentionEntityKey } from "../types.js";

/** Number of physical keys on a Stream Deck+. */
export const KEY_COUNT = 8;

/** Parse an ISO timestamp to epoch ms, treating unparseable values as oldest. */
function toMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Sort attention items newest-first by createdAt.
 *
 * Ties (or unparseable timestamps) fall back to id for a stable, deterministic
 * order so the same input always produces the same key layout.
 */
export function sortNewestFirst(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => {
    const diff = toMs(b.createdAt) - toMs(a.createdAt);
    if (diff !== 0) return diff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Apply the agent filter (dial 2). "all" passes everything through. */
export function applyFilter(items: AttentionItem[], filter: AgentFilter): AttentionItem[] {
  if (filter === "all") return items;
  return items.filter((it) => it.agent === filter);
}

/**
 * Triage rank for the key grid. Panes that currently want you come first:
 * failed → permission → waiting; panes that are actively working (no longer
 * waiting on you) sink to the end regardless of their lingering notification.
 */
export function itemRank(item: AttentionItem): number {
  if (item.stalled) return 3; // working but gone silent — probably hung; surface it
  if (item.activity === "working") return 5; // actively working: sink to the end
  if (item.reason === "failed") return 0;
  if (item.reason === "blocked") return 1; // permission
  if (item.needsInput) return 2; // cmux "Needs": agent waiting on you
  return 4; // plain waiting
}

/**
 * Order for the key grid: the panes that want you (failed/permission/waiting)
 * land top-left, working panes sink to the end. Array.sort is stable, so within
 * a rank the input order (newest-first) is preserved.
 */
export function triageOrder(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => itemRank(a) - itemRank(b));
}

/**
 * True when an item is a DECISION that wants the human right now — failed,
 * blocked (permission), or cmux "needs input" — as opposed to a plain waiting
 * or an actively-working pane. This is the subset the Decisions view shows
 * (the same top triage bands, ranks 0–2).
 */
export function isDecision(item: AttentionItem): boolean {
  return itemRank(item) <= 2;
}

/**
 * Collapse to one item per attention entity, keeping the newest.
 *
 * cmux accumulates a notification per agent turn, so a single workspace can have
 * many (e.g. a "done" then a "waiting"). Given a newest-first list, this keeps
 * only the first (latest) per workspace — so each repo occupies one key showing
 * its current state, instead of several stale duplicates. Herdr supplies a
 * terminal entity key so concurrent agents in one workspace retain their keys.
 */
export function dedupeNewestPerWorkspace(sortedNewestFirst: AttentionItem[]): AttentionItem[] {
  const seen = new Set<string>();
  const out: AttentionItem[] = [];
  for (const it of sortedNewestFirst) {
    const key = attentionEntityKey(it);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/** Assign items to the physical grid; unused slots remain empty. */
export function assignSlots(
  sortedItems: AttentionItem[],
  offset = 0,
  keyCount = KEY_COUNT,
): (AttentionItem | null)[] {
  const start = clampOffset(offset, sortedItems.length, keyCount);
  return Array.from({ length: keyCount }, (_, i) => sortedItems[start + i] ?? null);
}

/**
 * Clamp a scroll offset so the visible window always shows real items when any
 * exist. Offsets that would scroll past the end snap back to the last full-ish
 * page; negative offsets snap to 0.
 */
export function clampOffset(offset: number, total: number, keyCount = KEY_COUNT): number {
  if (total <= keyCount) return 0;
  const max = total - 1; // allow scrolling until the last item sits in slot 0
  if (offset < 0) return 0;
  if (offset > max) return max;
  return offset;
}

/**
 * Map a Stream Deck key coordinate to a slot index for the 4×2 keypad.
 *
 * Stream Deck+ keypad coordinates are { column: 0..3, row: 0..1 }.
 */
export function coordinatesToSlot(column: number, row: number): number {
  return row * 4 + column;
}
