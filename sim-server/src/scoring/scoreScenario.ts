import type { SessionFile, FinalScore } from "../session/SessionEvent.js";
import type { Scenario } from "./scenarios.js";

// First-pass numbers, same caveat as Phase 6's reward weights and this file's own
// SCENARIO_CONFIGS rates — expect to retune after watching real playthroughs.
const RUSH_HOUR_WAIT_THRESHOLD_S = 20;
const EV_TRANSIT_THRESHOLD_S = 35;
const CHAOS_WAIT_INCREASE_THRESHOLD_PCT = 15;
const PED_WAIT_THRESHOLD_S = 12;

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((sum, n) => sum + n, 0) / nums.length : 0;
}

function scoreThresholded(scenario: Scenario, actual: number, thresholdS: number): FinalScore {
  const deltaPct = ((thresholdS - actual) / thresholdS) * 100;
  return { scenario, result: actual <= thresholdS ? "pass" : "fail", avgWaitDeltaPct: deltaPct };
}

export function scoreScenario(scenario: Scenario, session: SessionFile): FinalScore {
  switch (scenario) {
    case "rush_hour":
      return scoreThresholded(scenario, avg(session.kpiSnapshots.map((k) => k.avgVehicleWaitS)), RUSH_HOUR_WAIT_THRESHOLD_S);

    case "pedestrian_pressure":
      return scoreThresholded(scenario, avg(session.kpiSnapshots.map((k) => k.avgPedWaitS)), PED_WAIT_THRESHOLD_S);

    case "emergency_vehicle": {
      const preempted = session.events.some((e) => e.type === "ev_preempt");
      const complete = session.events.find((e) => e.type === "ev_complete");
      const transitTimeS = complete && complete.type === "ev_complete" ? complete.transitTimeS : Infinity;
      const pass = preempted && transitTimeS <= EV_TRANSIT_THRESHOLD_S;
      const deltaPct = ((EV_TRANSIT_THRESHOLD_S - transitTimeS) / EV_TRANSIT_THRESHOLD_S) * 100;
      return { scenario, result: pass ? "pass" : "fail", avgWaitDeltaPct: deltaPct };
    }

    case "chaos": {
      const hasCollision = session.events.some((e) => e.type === "collision");
      const snapshots = session.kpiSnapshots;
      const firstHalf = snapshots.slice(0, Math.ceil(snapshots.length / 2));
      const secondHalf = snapshots.slice(Math.ceil(snapshots.length / 2));
      const baselineWait = avg(firstHalf.map((k) => k.avgVehicleWaitS));
      const finalWait = avg(secondHalf.map((k) => k.avgVehicleWaitS));
      const increasePct = baselineWait === 0 ? (finalWait > 0 ? 100 : 0) : ((finalWait - baselineWait) / baselineWait) * 100;
      const pass = increasePct >= CHAOS_WAIT_INCREASE_THRESHOLD_PCT || hasCollision;
      return { scenario, result: pass ? "pass" : "fail", avgWaitDeltaPct: increasePct };
    }
  }
}
