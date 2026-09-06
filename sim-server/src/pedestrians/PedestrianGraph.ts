import type { PedestrianNode, PedestrianEdge } from "../maps/MapDefinition.js";

export class PedestrianGraph {
  private readonly nodesById = new Map<string, PedestrianNode>();
  private readonly adjacency = new Map<string, PedestrianEdge[]>();

  constructor(nodes: PedestrianNode[], edges: PedestrianEdge[]) {
    for (const node of nodes) {
      this.nodesById.set(node.id, node);
      this.adjacency.set(node.id, []);
    }
    for (const edge of edges) {
      this.adjacency.get(edge.from)?.push(edge);
      this.adjacency.get(edge.to)?.push({ ...edge, from: edge.to, to: edge.from });
    }
  }

  node(id: string): PedestrianNode {
    const node = this.nodesById.get(id);
    if (!node) throw new Error(`Unknown pedestrian node: ${id}`);
    return node;
  }

  edgeBetween(a: string, b: string): PedestrianEdge | undefined {
    return this.adjacency.get(a)?.find((e) => e.to === b);
  }

  shortestPath(fromId: string, toId: string): string[] {
    this.node(fromId);
    const target = this.node(toId);

    const dist = new Map<string, number>([[fromId, 0]]);
    const prev = new Map<string, string>();
    const visited = new Set<string>();
    const open = new Set<string>([fromId]);

    const heuristic = (id: string) => {
      const n = this.node(id);
      return Math.hypot(n.x - target.x, n.y - target.y);
    };

    while (open.size > 0) {
      let current: string | null = null;
      let bestScore = Infinity;
      for (const id of open) {
        const score = (dist.get(id) ?? Infinity) + heuristic(id);
        if (score < bestScore) {
          bestScore = score;
          current = id;
        }
      }
      if (current === null || current === toId) break;

      open.delete(current);
      visited.add(current);

      for (const edge of this.adjacency.get(current) ?? []) {
        if (visited.has(edge.to)) continue;
        const a = this.node(current);
        const b = this.node(edge.to);
        const weight = Math.hypot(b.x - a.x, b.y - a.y);
        const tentative = (dist.get(current) ?? Infinity) + weight;
        if (tentative < (dist.get(edge.to) ?? Infinity)) {
          dist.set(edge.to, tentative);
          prev.set(edge.to, current);
          open.add(edge.to);
        }
      }
    }

    if (fromId !== toId && !prev.has(toId)) {
      throw new Error(`No path from ${fromId} to ${toId}`);
    }

    const path: string[] = [toId];
    let cursor = toId;
    while (cursor !== fromId) {
      const parent = prev.get(cursor);
      if (!parent) break;
      path.unshift(parent);
      cursor = parent;
    }
    return path;
  }
}
