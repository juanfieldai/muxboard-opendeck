import { escapeXml, fitText } from "./format.js";

/** Drawable N1 strip area, inside the driver's black side margins (20 bezel-hidden + 10 visible columns). */
const PANEL_WIDTH = 390;
const PANEL_HEIGHT = 85;

export interface NeoPanelState {
  page: "agents" | "actions";
  view: "all" | "needs";
  count: number;
  needsCount: number;
  selectedName?: string;
  selectedState?: string;
  actionName?: string;
}

/** Render the Infobar banner for the N1 strip's 390×85 drawable area. */
export function renderNeoPanel(state: NeoPanelState): string {
  const page = state.page === "actions" ? "ACTIONS" : "AGENTS";
  const view = state.view === "needs" ? `NEEDS ${state.needsCount}` : `ALL ${state.count}`;
  const fit = fitText(state.selectedName || "No agent selected", PANEL_WIDTH, 30, 12, 20);
  const lineHeight = fit.fontSize * 1.14;
  const start = 41 - fit.lines.length * lineHeight / 2 + fit.fontSize * 0.8;
  const title = fit.lines.map((line, row) => `<text x="0" y="${(start + row * lineHeight).toFixed(1)}" font-size="${fit.fontSize}" font-weight="700" fill="#f1f4f8">${escapeXml(line)}</text>`).join("");
  const detail = state.page === "actions" ? "TARGET" : state.selectedState || "—";
  const hint = state.page === "actions" ? `Press: ${state.actionName || "Back"}` : "Turn select · Press open";
  const hintFit = fitText(hint, 220, 14, 9, 11);
  const accent = state.page === "actions" ? "#e070bd" : "#38bdf8";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PANEL_WIDTH}" height="${PANEL_HEIGHT}" viewBox="0 0 ${PANEL_WIDTH} ${PANEL_HEIGHT}"><rect width="${PANEL_WIDTH}" height="${PANEL_HEIGHT}" fill="#0b0c0e"/><rect y="${PANEL_HEIGHT - 2}" width="${PANEL_WIDTH}" height="2" fill="${accent}"/><g font-family="Noto Sans Mono, monospace"><text x="0" y="15" font-size="11" fill="${accent}">${page} · ${view}</text><text x="${PANEL_WIDTH}" y="15" text-anchor="end" font-size="10" fill="#8c96a8">B hold: ${state.page === "actions" ? "Agents" : "Actions"}</text>${title}<text x="0" y="74" font-size="10" fill="#8c96a8">${escapeXml(detail)}</text><text x="${PANEL_WIDTH}" y="74" text-anchor="end" font-size="${hintFit.fontSize}" fill="#c3cad6">${escapeXml(hintFit.lines.join(" "))}</text></g></svg>`;
}
