import { readFileSync } from "node:fs";
import path from "node:path";
import type { ApproachDef, MapDefinition } from "./MapDefinition.js";

export function loadMap(relativePath: string): MapDefinition {
  // Resolved relative to this module's own directory (sim-server/src/maps), not the caller's —
  // every call site across the codebase uses the same "../../maps/<file>.json" convention
  // regardless of how deeply nested the calling test file is.
  const fullPath = path.resolve(import.meta.dirname, "..", relativePath);
  const raw = JSON.parse(readFileSync(fullPath, "utf-8"));

  if (!raw.id || !Array.isArray(raw.intersections) || !Array.isArray(raw.approaches)) {
    throw new Error(`Invalid map file at ${fullPath}: missing id/intersections/approaches`);
  }
  for (const intersection of raw.intersections) {
    if (!Array.isArray(intersection.phases) || intersection.phases.length === 0) {
      throw new Error(`Intersection ${intersection.id} has no phases`);
    }
  }
  if (!Array.isArray(raw.pedestrianNodes) || !Array.isArray(raw.pedestrianEdges)) {
    throw new Error(`Invalid map file at ${fullPath}: missing pedestrianNodes/pedestrianEdges`);
  }

  // Normalize every phase to allowedApproachIds, once, here — so every other piece of code past
  // this point (SignalController, EvRouter, RL observation building) only ever needs to read
  // allowedApproachIds, never the legacy compass allowedDirections/direction fields. A map that
  // already sets allowedApproachIds directly (fixture_curved_3int.json onward) passes through
  // unchanged; grid_1x1_v1.json's raw allowedDirections gets derived into the same shape.
  for (const intersection of raw.intersections) {
    const ownApproaches = raw.approaches.filter((a: ApproachDef) => a.intersectionId === intersection.id);
    for (const phase of intersection.phases) {
      if (phase.allowedApproachIds) continue;
      if (!phase.allowedDirections) {
        throw new Error(`Phase ${phase.id} on ${intersection.id} has neither allowedApproachIds nor allowedDirections`);
      }
      phase.allowedApproachIds = ownApproaches
        .filter((a: ApproachDef) => a.direction && phase.allowedDirections!.includes(a.direction))
        .map((a: ApproachDef) => a.id);
    }
  }

  return raw as MapDefinition;
}
