import type { MapDefinition } from "../maps/MapDefinition.js";

export interface RoadNode {
  id: string;
  x: number;
  y: number;
}

export interface RoadEdge {
  from: string;
  to: string;
  approachId: string;
}

export class RoadGraph {
  private readonly nodesById = new Map<string, RoadNode>();
  private readonly adjacency = new Map<string, RoadEdge[]>();
  private readonly edges: RoadEdge[];

  constructor(nodes: RoadNode[], edges: RoadEdge[]) {
    this.edges = edges;
    for (const node of nodes) {
      this.nodesById.set(node.id, node);
      this.adjacency.set(node.id, []);
    }
    for (const edge of edges) {
      this.adjacency.get(edge.from)?.push(edge);
    }
  }

  node(id: string): RoadNode {
    const node = this.nodesById.get(id);
    if (!node) throw new Error(`Unknown road node: ${id}`);
    return node;
  }

  // Directly-connected real intersection IDs — used for the rule-based fallback's neighbor-aware
  // coordination (spec §8.2). Excludes synthetic "end_<approachId>" spoke nodes (terminal far
  // points aren't intersections with their own SignalController). Considers edges in either
  // direction: since each two-way connector road is two separate directed approach edges (one per
  // direction, not an auto-reversed copy — see buildRoadGraph), a neighbor reachable only via the
  // *other* approach's edge (stored under that edge's own "from") still counts as a neighbor.
  neighborsOf(intersectionId: string): string[] {
    const neighbors = new Set<string>();
    for (const edge of this.edges) {
      if (edge.from === intersectionId && !edge.to.startsWith("end_")) neighbors.add(edge.to);
      if (edge.to === intersectionId && !edge.from.startsWith("end_")) neighbors.add(edge.from);
    }
    neighbors.delete(intersectionId);
    return [...neighbors];
  }

  shortestPath(fromId: string, toId: string): { nodeIds: string[]; edges: RoadEdge[] } {
    this.node(fromId);
    const target = this.node(toId);

    const dist = new Map<string, number>([[fromId, 0]]);
    const prev = new Map<string, { nodeId: string; edge: RoadEdge }>();
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
          prev.set(edge.to, { nodeId: current, edge });
          open.add(edge.to);
        }
      }
    }

    if (fromId !== toId && !prev.has(toId)) {
      throw new Error(`No route from ${fromId} to ${toId}`);
    }

    const nodeIds: string[] = [toId];
    const edges: RoadEdge[] = [];
    let cursor = toId;
    while (cursor !== fromId) {
      const step = prev.get(cursor);
      if (!step) break;
      nodeIds.unshift(step.nodeId);
      edges.unshift(step.edge);
      cursor = step.nodeId;
    }
    return { nodeIds, edges };
  }
}

export function buildRoadGraph(mapDef: MapDefinition): RoadGraph {
  const nodes: RoadNode[] = mapDef.intersections.map((i) => ({ id: i.id, x: i.x, y: i.y }));
  const edges: RoadEdge[] = [];

  const intersectionAt = (x: number, y: number) =>
    mapDef.intersections.find((i) => Math.hypot(i.x - x, i.y - y) < 1);

  for (const approach of mapDef.approaches) {
    const farIntersection = intersectionAt(approach.laneStartX, approach.laneStartY);
    if (farIntersection && farIntersection.id !== approach.intersectionId) {
      // Connector between two real intersections: one directed edge, its own natural direction
      // (laneStart -> laneEnd/intersectionId). The opposite physical direction is covered by a
      // *different* approach object (e.g. b_from_a for a_from_b) — never by reversing this one.
      edges.push({ from: farIntersection.id, to: approach.intersectionId, approachId: approach.id });
    } else {
      // Terminal spoke: same approach reversed for exit, exactly like today's single-intersection
      // behavior (a dead-end leg has no separate "opposite direction" approach object).
      const endNodeId = `end_${approach.id}`;
      nodes.push({ id: endNodeId, x: approach.laneStartX, y: approach.laneStartY });
      edges.push({ from: endNodeId, to: approach.intersectionId, approachId: approach.id });
      edges.push({ from: approach.intersectionId, to: endNodeId, approachId: approach.id });
    }
  }

  return new RoadGraph(nodes, edges);
}
