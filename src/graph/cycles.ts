import type { EdgeV1, GraphV1 } from "./types.js";

export interface ImportCycle {
  files: string[];
  edges: EdgeV1[];
}

export function formatImportCycles(cycles: ImportCycle[]): string {
  if (cycles.length === 0) return "no import cycles found\n";
  return (
    cycles
      .map((cycle, index) => {
        const lines = [`Cycle ${index + 1} · ${cycle.files.length} files`];
        for (const edge of cycle.edges) {
          const source = edge.line === undefined ? edge.source : `${edge.source}:${edge.line}`;
          lines.push(`  ${source} imports → ${edge.target}${edge.lazy ? " [lazy]" : ""}`);
        }
        return lines.join("\n");
      })
      .join("\n\n") + "\n"
  );
}

/** Find every multi-file strongly connected component in the resolved import graph. */
export function findImportCycles(graph: GraphV1): ImportCycle[] {
  const files = graph.nodes.filter((node) => node.kind === "file").sort((a, b) => a.id.localeCompare(b.id));
  const fileIds = new Set(files.map((file) => file.id));
  const adjacency = new Map(files.map((file) => [file.id, [] as string[]]));
  const importsBySource = new Map<string, EdgeV1[]>();
  for (const edge of graph.edges) {
    if (edge.relation !== "imports" || !fileIds.has(edge.source) || !fileIds.has(edge.target)) continue;
    adjacency.get(edge.source)!.push(edge.target);
    const sourceEdges = importsBySource.get(edge.source);
    if (sourceEdges) sourceEdges.push(edge);
    else importsBySource.set(edge.source, [edge]);
  }
  for (const neighbours of adjacency.values()) neighbours.sort((a, b) => a.localeCompare(b));

  let nextIndex = 0;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const enter = (id: string): void => {
    index.set(id, nextIndex);
    lowlink.set(id, nextIndex);
    nextIndex++;
    stack.push(id);
    onStack.add(id);
  };

  for (const file of files) {
    if (index.has(file.id)) continue;
    enter(file.id);
    const work: Array<{ id: string; parent?: string; nextNeighbour: number }> = [
      { id: file.id, nextNeighbour: 0 },
    ];

    while (work.length > 0) {
      const frame = work.at(-1)!;
      const neighbours = adjacency.get(frame.id)!;
      if (frame.nextNeighbour < neighbours.length) {
        const neighbour = neighbours[frame.nextNeighbour++];
        if (!index.has(neighbour)) {
          enter(neighbour);
          work.push({ id: neighbour, parent: frame.id, nextNeighbour: 0 });
        } else if (onStack.has(neighbour)) {
          lowlink.set(frame.id, Math.min(lowlink.get(frame.id)!, index.get(neighbour)!));
        }
        continue;
      }

      work.pop();
      if (frame.parent !== undefined) {
        lowlink.set(frame.parent, Math.min(lowlink.get(frame.parent)!, lowlink.get(frame.id)!));
      }
      if (lowlink.get(frame.id) !== index.get(frame.id)) continue;

      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== frame.id);
      if (component.length > 1) components.push(component.sort((a, b) => a.localeCompare(b)));
    }
  }

  return components
    .sort(compareMembers)
    .map((members) => ({
      files: members,
      edges: cycleEdges(importsBySource, members),
    }));
}

function compareMembers(a: string[], b: string[]): number {
  return a.join("\0").localeCompare(b.join("\0"));
}

function cycleEdges(importsBySource: Map<string, EdgeV1[]>, members: string[]): EdgeV1[] {
  const memberSet = new Set(members);
  return members
    .flatMap((source) => importsBySource.get(source) ?? [])
    .filter((edge) => memberSet.has(edge.target))
    .sort(
      (a, b) =>
        a.source.localeCompare(b.source) ||
        a.target.localeCompare(b.target) ||
        (a.line ?? 0) - (b.line ?? 0) ||
        Number(a.lazy ?? false) - Number(b.lazy ?? false),
    );
}
