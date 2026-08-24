/**
 * Detail panel: the selected node's type, summary, sources, and its links in
 * both directions — amber "Depends on" (outgoing) and teal "Depended on by"
 * (incoming), mirroring the focus-mode edge colors.
 */
import { type Evidence, type VizGraph, colorToken, cvar } from "./data.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/**
 * One snippet: its label, why it is here, and the lines themselves.
 *
 * Line text is repo content — on a fork PR, written by whoever opened it — so
 * every part of this is escaped.
 */
function evidenceBlock(e: Evidence): string {
  const rows = e.lines
    .map((l) => {
      const cls = l.sign === "+" ? "add" : l.sign === "-" ? "del" : "ctx";
      return `<div class="ev-l ${cls}"><span class="ev-n">${l.n ?? ""}</span>` +
        `<span class="ev-s">${l.sign === " " ? "" : l.sign}</span>` +
        `<span class="ev-t">${esc(l.text)}</span></div>`;
    })
    .join("");
  return `<div class="ev">` +
    `<div class="ev-h mono">${esc(e.label)}${e.note ? ` <span class="ev-note">${esc(e.note)}</span>` : ""}</div>` +
    `<div class="ev-b mono">${rows}</div>` +
    (e.more ? `<div class="ev-more">+ ${e.more} more lines</div>` : "") +
    `</div>`;
}

export function renderDetail(
  host: HTMLElement,
  graph: VizGraph | null,
  tab: "context" | "code",
  id: string | null,
  onNavigate: (id: string) => void,
): void {
  if (!id || !graph) {
    host.innerHTML = '<div class="empty">Select a node to view details</div>';
    return;
  }
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) {
    host.innerHTML = '<div class="empty">Select a node to view details</div>';
    return;
  }
  const color = cvar(colorToken(tab, node.type));
  const name = (nid: string) => graph.nodes.find((n) => n.id === nid)?.name ?? nid;
  const out = graph.edges.filter((e) => e.source === id);
  const inn = graph.edges.filter((e) => e.target === id);

  let html = `<span class="d-type"><span class="sw" style="background:${color}"></span>${esc(node.type)}</span>`;
  html += `<h3>${esc(node.name)}</h3>`;
  if (node.summary) html += `<p class="summary">${esc(node.summary)}</p>`;
  // Evidence replaces the plain path list wherever it exists: a reader wants the
  // lines, and showing both would say the same thing twice.
  if (node.evidence?.length) {
    html += `<div class="d-label">Code · ${node.evidence.length}</div>`;
    for (const e of node.evidence) html += evidenceBlock(e);
    const extra = node.sources.length - node.evidence.length;
    if (extra > 0) html += `<div class="src mono">+ ${extra} more, not shown</div>`;
  } else if (node.sources.length) {
    html += `<div class="d-label">Sources · ${node.sources.length}</div>`;
    for (const s of node.sources) html += `<div class="src mono">${esc(s)}</div>`;
  }
  const linkList = (edges: typeof out, dotColor: string, title: string, other: (e: (typeof out)[number]) => string) => {
    if (!edges.length) return;
    html += `<div class="d-label"><span class="dot" style="background:${dotColor}"></span>${title} · ${edges.length}</div>`;
    for (const e of edges) {
      html += `<button class="lnk" data-go="${esc(other(e))}">` +
        `<span class="rel">${esc(e.relation.replace(/_/g, " "))}</span> ` +
        `<span class="to">${esc(name(other(e)))}</span>` +
        (e.description ? `<div class="desc">${esc(e.description)}</div>` : "") +
        `</button>`;
    }
  };
  linkList(out, cvar("--fil"), "Depends on", (e) => e.target);
  linkList(inn, cvar("--accent"), "Depended on by", (e) => e.source);

  host.innerHTML = html;
  host.querySelectorAll<HTMLButtonElement>("[data-go]").forEach((b) => {
    b.addEventListener("click", () => onNavigate(b.dataset.go!));
  });
}
