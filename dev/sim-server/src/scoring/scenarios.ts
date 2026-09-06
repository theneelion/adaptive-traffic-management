export type Scenario = "rush_hour" | "emergency_vehicle" | "chaos" | "pedestrian_pressure";

export interface ScenarioConfig {
  vehicleArrivalRatePerMin: number;
  pedestrianArrivalRatePerMin: number;
  durationS: number;
  autoSpawnEv: boolean;
}

// Vehicle rates retuned against the real city map + real ai-service (not a mock), after
// TrafficController's MAX_VEHICLES_PER_APPROACH dropped 8 -> 5 -> 3 (see its own comment): the
// original rates (60/30/30/20) were tuned against the old, higher cap and now oversaturate the
// network almost immediately regardless of duration, producing permanent-looking congestion
// rather than the intended "busy but flowing" scenario feel. Halved each vehicle rate, empirically
// re-checked at the new cap: a sustained run stays visibly moving (nonzero average speed, steadily
// climbing completions) instead of saturating into near-total gridlock. Pedestrian rates are
// unchanged — pedestrian-crowd congestion is a separate, already-flagged concern this pass doesn't
// touch.
export const SCENARIO_CONFIGS: Record<Scenario, ScenarioConfig> = {
  rush_hour: { vehicleArrivalRatePerMin: 30, pedestrianArrivalRatePerMin: 40, durationS: 120, autoSpawnEv: false },
  emergency_vehicle: { vehicleArrivalRatePerMin: 15, pedestrianArrivalRatePerMin: 20, durationS: 60, autoSpawnEv: true },
  chaos: { vehicleArrivalRatePerMin: 15, pedestrianArrivalRatePerMin: 20, durationS: 90, autoSpawnEv: false },
  pedestrian_pressure: { vehicleArrivalRatePerMin: 10, pedestrianArrivalRatePerMin: 70, durationS: 120, autoSpawnEv: false }
};
