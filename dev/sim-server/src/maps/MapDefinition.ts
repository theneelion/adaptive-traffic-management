export type Direction = "N" | "S" | "E" | "W";

export interface SignalPhaseDef {
  id: string;
  // Legacy compass-based phase membership. loadMap normalizes this into allowedApproachIds below
  // for any map that only sets this field (e.g. grid_1x1_v1.json) — nothing downstream of loadMap
  // reads allowedDirections directly.
  allowedDirections?: Direction[];
  // Preferred: explicit approach-ID membership. Always populated after loadMap, regardless of
  // which raw field the source JSON used.
  allowedApproachIds?: string[];
  durationMs: number;
}

export interface IntersectionDef {
  id: string;
  x: number;
  y: number;
  phases: SignalPhaseDef[];
}

export interface ApproachDef {
  id: string;
  intersectionId: string;
  // Optional: legacy compass hint, used only by loadMap's allowedDirections normalization. Real
  // geometry/routing code computes headings from coordinates (TurnPaths.headingIntoIntersection),
  // never from this field.
  direction?: Direction;
  laneStartX: number;
  laneStartY: number;
  laneEndX: number;
  laneEndY: number;
  width: number;
  // Optional: when present (length >= 3), the approach's centerline is a smooth curve through
  // these points (Catmull-Rom-derived, see TurnPaths.buildApproachCenterline) instead of a
  // straight line from laneStartX/Y to laneEndX/Y. Absent (the default, and always true for
  // grid_1x1_v1.json) means byte-identical straight-line behavior to before this field existed.
  // waypoints[0] and waypoints[waypoints.length - 1] must equal (laneStartX,laneStartY) and
  // (laneEndX,laneEndY) respectively when present.
  waypoints?: { x: number; y: number }[];
}

export interface PedestrianNode {
  id: string;
  x: number;
  y: number;
}

export interface PedestrianEdge {
  from: string;
  to: string;
  kind: "sidewalk" | "crosswalk";
  crossingId?: string;
  approachId?: string;
}

export interface MapDefinition {
  id: string;
  intersections: IntersectionDef[];
  approaches: ApproachDef[];
  pedestrianNodes: PedestrianNode[];
  pedestrianEdges: PedestrianEdge[];
}

const TERMINAL_EPSILON = 1;

// True when this approach's laneStart is a genuine far spawn/despawn point (no other intersection
// sits there) — false for a "connector" approach whose laneStart coincides with a different real
// intersection (a road directly linking two intersections). Used by RoadGraph (only terminals get
// reversed-for-exit edges) and TrafficController (only terminals are valid spawn points — a
// connector's laneStart is mid-network, not a place a new vehicle should materialize).
export function isTerminalApproach(mapDef: MapDefinition, approach: ApproachDef): boolean {
  return !mapDef.intersections.some(
    (i) => Math.hypot(i.x - approach.laneStartX, i.y - approach.laneStartY) < TERMINAL_EPSILON
  );
}
