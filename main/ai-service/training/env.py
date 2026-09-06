from typing import ClassVar

import gymnasium as gym
import numpy as np
from app.reward import compute_reward, RewardInputs, RewardWeights
from app.observation import build_observation_vector, OBS_APPROACH_ORDER

PHASE_APPROACHES = {
    "NS_through": {"app_N", "app_S"},
    "EW_through": {"app_E", "app_W"},
}
PHASE_IDS = list(PHASE_APPROACHES.keys())

# SignalPhaseMachine (Phase 2) pays a real yellow+all-red clearance on every phase switch, during
# which no direction gets extra green time. This proxy env switches phases instantly, so without
# this deduction a trained policy has zero incentive to avoid flip-flopping — deducting a fixed
# amount of "lost service" from the throughput term whenever the action changes the current phase
# keeps that incentive present without modeling the clearance sub-phases themselves.
YELLOW_S = 3.0
ALL_RED_S = 1.5


class TrafficSignalEnv(gym.Env):
    metadata: ClassVar[dict] = {"render_modes": []}

    def __init__(
        self,
        arrival_rate_per_min: float = 20.0,
        ped_arrival_rate_per_min: float = 10.0,
        decision_interval_s: float = 1.5,
        episode_steps: int = 400,
        reward_weights: RewardWeights | None = None,
    ):
        super().__init__()
        self.arrival_rate_per_s = arrival_rate_per_min / 60.0
        self.ped_arrival_rate_per_s = ped_arrival_rate_per_min / 60.0
        self.service_rate_per_s = 0.5  # vehicles/s served on green, per approach
        self.ped_service_rate_per_s = 0.8
        self.jaywalk_queue_threshold = 4.0
        self.decision_interval_s = decision_interval_s
        self.episode_steps = episode_steps
        self.weights = reward_weights or RewardWeights()
        self.dead_time_penalty_units = (YELLOW_S + ALL_RED_S) * self.service_rate_per_s

        self.action_space = gym.spaces.Discrete(len(PHASE_IDS))
        obs_dim = len(OBS_APPROACH_ORDER) * 2 + len(PHASE_IDS) + 1 + len(OBS_APPROACH_ORDER) * 2
        self.observation_space = gym.spaces.Box(low=0, high=np.inf, shape=(obs_dim,), dtype=np.float32)

        self.rng = np.random.default_rng()
        self.queues: dict[str, float] = {}
        self.ped_queues: dict[str, float] = {}
        self.current_phase_idx = 0
        self.time_in_phase_s = 0.0
        self.step_count = 0

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        self.rng = np.random.default_rng(seed)
        self.queues = {a: 0.0 for a in OBS_APPROACH_ORDER}
        self.ped_queues = {a: 0.0 for a in OBS_APPROACH_ORDER}
        self.current_phase_idx = 0
        self.time_in_phase_s = 0.0
        self.step_count = 0
        return self._observe(), {}

    def step(self, action: int):
        switched = int(action) != self.current_phase_idx
        if switched:
            self.current_phase_idx = int(action)
            self.time_in_phase_s = 0.0
        else:
            self.time_in_phase_s += self.decision_interval_s

        green = PHASE_APPROACHES[PHASE_IDS[self.current_phase_idx]]
        jaywalk_events = 0

        for approach in OBS_APPROACH_ORDER:
            self.queues[approach] += self.rng.poisson(self.arrival_rate_per_s * self.decision_interval_s)
            if approach in green:
                served = min(self.queues[approach], self.service_rate_per_s * self.decision_interval_s)
                self.queues[approach] -= served

            self.ped_queues[approach] += self.rng.poisson(self.ped_arrival_rate_per_s * self.decision_interval_s)
            if approach not in green:
                crossed = min(self.ped_queues[approach], self.ped_service_rate_per_s * self.decision_interval_s)
                self.ped_queues[approach] -= crossed
            elif self.ped_queues[approach] > self.jaywalk_queue_threshold:
                jaywalk_events += 1
                self.ped_queues[approach] *= 0.8

        queue_values = list(self.queues.values())
        dead_time_penalty = self.dead_time_penalty_units if switched else 0.0
        throughput = max(
            0.0,
            sum(min(self.queues[a], self.service_rate_per_s * self.decision_interval_s) for a in green) - dead_time_penalty,
        )
        reward_inputs = RewardInputs(
            avg_vehicle_wait=float(np.mean(queue_values)),
            approach_wait_variance=float(np.var(queue_values)),
            avg_pedestrian_wait=float(np.mean(list(self.ped_queues.values()))),
            jaywalk_event_count=jaywalk_events,
            throughput=throughput,
        )
        reward = compute_reward(reward_inputs, self.weights)

        self.step_count += 1
        truncated = self.step_count >= self.episode_steps
        info = {
            "avg_wait": reward_inputs.avg_vehicle_wait,
            "avg_ped_wait": reward_inputs.avg_pedestrian_wait,
            "jaywalk_events": jaywalk_events,
            "throughput": throughput,
            "deadTimePenalty": dead_time_penalty,
        }
        return self._observe(), reward, False, truncated, info

    def _observe(self) -> np.ndarray:
        approach_queues = {a: (self.queues[a], self.queues[a] / max(self.arrival_rate_per_s, 1e-6)) for a in OBS_APPROACH_ORDER}
        ped_queues = {a: (self.ped_queues[a], self.ped_queues[a] / max(self.ped_arrival_rate_per_s, 1e-6)) for a in OBS_APPROACH_ORDER}
        return build_observation_vector(
            approach_queues, self.current_phase_idx, len(PHASE_IDS), self.time_in_phase_s, ped_queues
        )
