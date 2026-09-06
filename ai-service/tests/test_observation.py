import numpy as np
from app.observation import build_observation_vector, OBS_APPROACH_ORDER


def test_vector_length_matches_expected_layout():
    approach_queues = {a: (1.0, 2.0) for a in OBS_APPROACH_ORDER}
    ped_queues = {a: (0.0, 0.0) for a in OBS_APPROACH_ORDER}
    obs = build_observation_vector(approach_queues, phase_idx=0, num_phases=2, time_in_phase_s=3.0, ped_queues=ped_queues)
    # 4 approaches x 2 (queue,wait) + 2 phase one-hot + 1 time-in-phase + 4 crossings x 2 (queue,wait)
    assert obs.shape == (4 * 2 + 2 + 1 + 4 * 2,)


def test_phase_one_hot_reflects_current_phase():
    approach_queues = {a: (0.0, 0.0) for a in OBS_APPROACH_ORDER}
    ped_queues = {a: (0.0, 0.0) for a in OBS_APPROACH_ORDER}
    obs = build_observation_vector(approach_queues, phase_idx=1, num_phases=2, time_in_phase_s=0.0, ped_queues=ped_queues)
    phase_onehot_start = 4 * 2
    assert obs[phase_onehot_start] == 0.0
    assert obs[phase_onehot_start + 1] == 1.0


def test_is_deterministic_for_the_same_inputs():
    approach_queues = {a: (3.0, 4.0) for a in OBS_APPROACH_ORDER}
    ped_queues = {a: (1.0, 2.0) for a in OBS_APPROACH_ORDER}
    a = build_observation_vector(approach_queues, phase_idx=0, num_phases=2, time_in_phase_s=1.0, ped_queues=ped_queues)
    b = build_observation_vector(approach_queues, phase_idx=0, num_phases=2, time_in_phase_s=1.0, ped_queues=ped_queues)
    assert np.array_equal(a, b)
