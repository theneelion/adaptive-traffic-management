from app.reward import compute_reward, RewardInputs, RewardWeights


def _state(**overrides) -> RewardInputs:
    base = {
        "avg_vehicle_wait": 0.0,
        "approach_wait_variance": 0.0,
        "avg_pedestrian_wait": 0.0,
        "jaywalk_event_count": 0,
        "throughput": 0.0,
    }
    base.update(overrides)
    return RewardInputs(**base)


def test_higher_vehicle_wait_reduces_reward():
    weights = RewardWeights()
    low = compute_reward(_state(avg_vehicle_wait=1.0), weights)
    high = compute_reward(_state(avg_vehicle_wait=10.0), weights)
    assert high < low


def test_higher_throughput_increases_reward():
    weights = RewardWeights()
    low = compute_reward(_state(throughput=1.0), weights)
    high = compute_reward(_state(throughput=10.0), weights)
    assert high > low


def test_higher_wait_variance_reduces_reward_fairness_term():
    weights = RewardWeights()
    fair = compute_reward(_state(approach_wait_variance=0.0), weights)
    unfair = compute_reward(_state(approach_wait_variance=5.0), weights)
    assert unfair < fair


def test_jaywalk_events_reduce_reward():
    weights = RewardWeights()
    none = compute_reward(_state(jaywalk_event_count=0), weights)
    some = compute_reward(_state(jaywalk_event_count=3), weights)
    assert some < none


def test_zero_weights_yield_zero_reward_regardless_of_state():
    zero_weights = RewardWeights(w1=0, w2=0, w3=0, w4=0, w5=0)
    assert compute_reward(_state(avg_vehicle_wait=100, throughput=50), zero_weights) == 0
