from dataclasses import dataclass


@dataclass
class RewardWeights:
    w1: float = 1.0  # avg vehicle wait
    w2: float = 0.5  # approach wait variance (fairness)
    w3: float = 1.0  # avg pedestrian wait
    w4: float = 2.0  # jaywalk event count
    w5: float = 0.3  # throughput


@dataclass
class RewardInputs:
    avg_vehicle_wait: float
    approach_wait_variance: float
    avg_pedestrian_wait: float
    jaywalk_event_count: int
    throughput: float


def compute_reward(state: RewardInputs, weights: RewardWeights) -> float:
    return (
        -(weights.w1 * state.avg_vehicle_wait)
        - (weights.w2 * state.approach_wait_variance)
        - (weights.w3 * state.avg_pedestrian_wait)
        - (weights.w4 * state.jaywalk_event_count)
        + (weights.w5 * state.throughput)
    )
