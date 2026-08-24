/**
 * graft viz — viewer entry point. Wires tabs, chips, legend, search, theme,
 * SSE live reload, and the three views (Context graph / Code graph / Outline).
 */
import { loadContextGraph, loadCodeGraph, onServerChange, chipKey, CHIP_HINT, colorToken, cvar, famOf, type VizGraph } from "./data.js";
import { GraphView } from "./graph.js";
import { renderDetail } from "./detail.js";
import { renderOutline } from "./tree.js";

type Tab = "context" | "code" | "outline";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const state = {
  tab: "context" as Tab,
  context: null as VizGraph | null,
  code: null as VizGraph | null,
  outlineOpen: {} as Record<string, boolean>,
};

const view = new GraphView($("graphSvg") as unknown as SVGSVGElement);

function activeGraph(): VizGraph | null {
  return state.tab === "context" ? state.context : state.code;
}

function graphTab(): "context" | "code" {
  return state.tab === "code" || state.tab === "outline" ? "code" : "context";
}

/* ---------- chips: verbs actually present, grouped only where obvious ---------- */
function renderChips(): void {
  const host = $("edgeChips");
  host.innerHTML = '<span class="cap">Edges</span>';
  const graph = activeGraph();
  if (!graph) return;
  const counts = new Map<string, number>();
  for (const e of graph.edges) {
    const key = chipKey(e.relation);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const keys = [...counts.keys()].sort((a, b) => {
    const rank = (k: string) => (k === "part of" ? 0 : k === "uses" ? 1 : 2);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  for (const key of keys) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "echip" + (view.hiddenRels[key] ? "" : " on");
    btn.innerHTML = `${glyphFor(key)} ${key} <span style="opacity:.55">${counts.get(key)}</span>`;
    btn.title = (CHIP_HINT[key] ?? `"${key}" edges`) + " — click to " + (view.hiddenRels[key] ? "show" : "hide");
    btn.addEventListener("click", () => {
      view.hiddenRels[key] = !view.hiddenRels[key];
      renderChips();
      view.restyle();
      updateShownCount();
    });
    host.appendChild(btn);
  }
}

function glyphFor(key: string): string {
  const fam = key === "part of" ? "structure" : key === "uses" ? "dependency" : famOf(key.replace(/ /g, "_"));
  const glyphs: Record<string, string> = {
    structure: '<svg width="20" height="8" aria-hidden="true"><line x1="1" y1="4" x2="19" y2="4" stroke="currentColor" stroke-width="3" opacity=".5"/></svg>',
    dependency: '<svg width="20" height="8" aria-hidden="true"><line x1="1" y1="4" x2="14" y2="4" stroke="currentColor" stroke-width="1.6"/><path d="M14,1 L19,4 L14,7 z" fill="currentColor"/></svg>',
    contract: '<svg width="20" height="8" aria-hidden="true"><line x1="1" y1="4" x2="13" y2="4" stroke="currentColor" stroke-width="1.4"/><path d="M13,1 L19,4 L13,7 z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    association: '<svg width="20" height="8" aria-hidden="true"><line x1="1" y1="4" x2="19" y2="4" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2 4" opacity=".7"/></svg>',
  };
  return glyphs[fam];
}

/* ---------- node-type legend ---------- */
function renderLegend(): void {
  const host = $("legend");
  host.innerHTML = "";
  const graph = activeGraph();
  if (!graph) return;
  const counts = new Map<string, number>();
  for (const n of graph.nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
  for (const [type, count] of counts) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "lchip" + (view.hiddenTypes[type] ? " off" : "");
    chip.innerHTML = `<span class="sw" style="background:${cvar(colorToken(graphTab(), type))}"></span>${type} <span style="color:var(--muted);font-weight:500">${count}</span>`;
    chip.addEventListener("click", () => {
      view.hiddenTypes[type] = !view.hiddenTypes[type];
      renderLegend();
      view.restyle();
      updateShownCount();
    });
    host.appendChild(chip);
  }
}

function updateShownCount(): void {
  const graph = activeGraph();
  if (!graph) { $("lcount").textContent = ""; return; }
  const shown = graph.nodes.filter((n) => !view.hiddenTypes[n.type]).length;
  $("lcount").textContent = `${shown} / ${graph.nodes.length} nodes shown`;
}

function updateCounts(): void {
  const el = $("counts");
  if (state.tab === "outline" && state.code) {
    const files = state.code.nodes.filter((n) => n.type === "file").length;
    el.textContent = `${files} files · ${state.code.nodes.length} symbols`;
  } else {
    const graph = activeGraph();
    el.textContent = graph ? `${graph.meta.nodeCount} nodes · ${graph.meta.edgeCount} links` : "";
  }
}

/* ---------- detail panel ---------- */
function showDetail(id: string | null): void {
  renderDetail($("detail"), state.tab === "context" ? state.context : state.code, graphTab(), id, (next) => {
    if (state.tab === "outline") {
      showDetail(next);
      renderOutline($("tree"), state.code!, next, state.outlineOpen, showDetail);
    } else {
      view.focus(next);
    }
  });
}

view.onSelect = (id) => showDetail(id);

/* ---------- tabs ---------- */
function setTab(tab: Tab): void {
  state.tab = tab;
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) => {
    b.setAttribute("aria-selected", b.dataset.tab === tab ? "true" : "false");
  });
  const isOutline = tab === "outline";
  $("canvasWrap").hidden = isOutline;
  $("outlineView").hidden = !isOutline;
  view.hiddenRels = {};
  view.hiddenTypes = {};
  view.selected = null;
  showDetail(null);

  const empty = $("graphEmpty");
  if (tab === "outline") {
    if (state.code) renderOutline($("tree"), state.code, null, state.outlineOpen, showDetail);
    else {
      $("outlineView").hidden = true;
      $("canvasWrap").hidden = false;
      showEmpty("No code graph yet — run <code>graft graph</code> to generate <span class=\"mono\">graph.json</span>.");
    }
  } else {
    const graph = activeGraph();
    if (!graph || graph.nodes.length === 0) {
      // A graph that exists but holds no nodes used to fall through to the canvas
      // and render nothing at all — worst on an exported page, where the reader
      // arrived from a link that promised a diagram.
      // The note names changed FILES, and a path on a fork's branch is written by
      // whoever opened the pull request — it reaches a published page, so it is
      // escaped rather than trusted.
      showEmpty(graph?.meta.emptyNote ? escapeText(graph.meta.emptyNote) : (tab === "code"
        ? "No code graph yet — run <code>graft graph</code> to generate <span class=\"mono\">graph.json</span>."
        : "No context graph — run <code>graft init</code> first."));
    } else {
      empty.hidden = true;
      view.resetView();
      view.setData(graph, graphTab());
      view.reheat();
    }
  }
  renderChips();
  renderLegend();
  updateShownCount();
  updateCounts();
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function showEmpty(html: string): void {
  const empty = $("graphEmpty");
  empty.innerHTML = html;
  empty.hidden = false;
}

document.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) => {
  b.addEventListener("click", () => setTab(b.dataset.tab as Tab));
});

/* ---------- search ---------- */
const search = $("search") as HTMLInputElement;
search.addEventListener("input", () => {
  view.query = search.value.trim();
  view.restyle();
});
search.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && view.query) {
    const hit = view.firstMatch();
    if (hit) view.focus(hit.id);
  }
});

/* ---------- zoom controls ---------- */
$("zin").addEventListener("click", () => view.zoomBy(1.25));
$("zout").addEventListener("click", () => view.zoomBy(1 / 1.25));
$("zreset").addEventListener("click", () => view.resetView());

/* ---------- theme ---------- */
const THEME_KEY = "graft-viz-theme";
const savedTheme = localStorage.getItem(THEME_KEY);
if (savedTheme) document.documentElement.setAttribute("data-theme", savedTheme);
$("themeBtn").addEventListener("click", () => {
  const root = document.documentElement;
  const current = root.getAttribute("data-theme");
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = current ? current === "dark" : systemDark;
  const next = isDark ? "light" : "dark";
  root.setAttribute("data-theme", next);
  localStorage.setItem(THEME_KEY, next);
  view.restyle();
  renderChips();
  renderLegend();
  showDetail(view.selected);
});

/* ---------- resizable detail panel ---------- */
const DETAIL_W_KEY = "graft-viz-detail-w";
const MIN_DETAIL = 220;
const rootEl = document.documentElement;
const clampDetail = (px: number): number =>
  Math.min(Math.max(MIN_DETAIL, Math.round(window.innerWidth * 0.6)), Math.max(MIN_DETAIL, Math.round(px)));
function setDetailWidth(px: number, persist = true): void {
  const w = clampDetail(px);
  rootEl.style.setProperty("--detail-w", `${w}px`);
  if (persist) localStorage.setItem(DETAIL_W_KEY, String(w));
}
const savedDetailW = Number(localStorage.getItem(DETAIL_W_KEY));
if (Number.isFinite(savedDetailW) && savedDetailW >= MIN_DETAIL) setDetailWidth(savedDetailW, false);

const resizer = $("detailResizer");
let draggingDetail = false;
resizer.addEventListener("pointerdown", (ev) => {
  const pe = ev as PointerEvent;
  draggingDetail = true;
  resizer.setPointerCapture(pe.pointerId);
  document.body.style.cursor = "col-resize";
  ev.preventDefault();
});
resizer.addEventListener("pointermove", (ev) => {
  if (!draggingDetail) return;
  // panel is flush to the window's right edge: width = distance from cursor to that edge.
  setDetailWidth(window.innerWidth - (ev as PointerEvent).clientX);
});
const endDetailDrag = (ev: Event): void => {
  if (!draggingDetail) return;
  draggingDetail = false;
  document.body.style.cursor = "";
  try { resizer.releasePointerCapture((ev as PointerEvent).pointerId); } catch { /* not captured */ }
  view.reheat();
};
resizer.addEventListener("pointerup", endDetailDrag);
resizer.addEventListener("pointercancel", endDetailDrag);
resizer.addEventListener("keydown", (ev) => {
  const ke = ev as KeyboardEvent;
  if (ke.key !== "ArrowLeft" && ke.key !== "ArrowRight") return;
  const step = ke.shiftKey ? 40 : 16;
  const cur = $("detail").getBoundingClientRect().width;
  setDetailWidth(cur + (ke.key === "ArrowLeft" ? step : -step));
  view.reheat();
  ev.preventDefault();
});

/* ---------- data loading + live reload ---------- */
async function loadAll(): Promise<void> {
  const [context, code] = await Promise.all([loadContextGraph(), loadCodeGraph()]);
  state.context = context;
  state.code = code;
  // The subtitle only exists on an exported page (`graft viz --export --title`),
  // where the same file is published per pull request and the reader needs to know
  // WHICH one they opened.
  const where = [context.meta.repoName, context.meta.subtitle].filter(Boolean).join(" · ");
  $("repoName").textContent = where;
  document.title = `graft viz — ${where}`;
  // A blast export ships one tab: its Code tab would be the repo's whole wiring
  // graph, which answers nothing about the pull request the page is about.
  const tabs = context.meta.tabs;
  if (tabs) {
    document.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) => {
      b.hidden = !tabs.includes(b.dataset.tab as Tab);
    });
  }
  // An exported page says which tab holds its content: a structural build has no
  // concept nodes, so the default Context tab would open on an empty canvas.
  const wanted = context.meta.defaultTab;
  setTab(wanted && wanted !== state.tab ? wanted : state.tab);
}

onServerChange(() => {
  const selected = view.selected;
  void loadAll().then(() => {
    if (selected) { view.selected = selected; view.restyle(); showDetail(selected); }
  });
});

void loadAll();
