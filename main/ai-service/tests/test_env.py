import numpy as np
from stable_baselines3.common.env_checker import check_env
from training.env import TrafficSignalEnv


def test_env_passes_sb3_env_checker():
    env = TrafficSignalEnv()
    check_env(env, warn=True)


def test_reset_returns_observation_of_expected_shape():
    env = TrafficSignalEnv()
    obs, _info = env.reset(seed=1)
    assert obs.shape == env.observation_space.shape


def test_step_returns_five_tuple_and_advances_state():
    env = TrafficSignalEnv()
    env.reset(seed=1)
    obs, reward, terminated, truncated, _info = env.step(0)
    assert obs.shape == env.observation_space.shape
    assert isinstance(reward, float)
    assert isinstance(terminated, bool)
    assert isinstance(truncated, bool)


def test_episode_truncates_after_configured_length():
    env = TrafficSignalEnv(episode_steps=5)
    env.reset(seed=1)
    truncated = False
    for _ in range(5):
        _, _, _, truncated, _ = env.step(0)
    assert truncated


def test_deterministic_for_a_fixed_seed():
    env_a = TrafficSignalEnv()
    env_a.reset(seed=42)
    env_b = TrafficSignalEnv()
    env_b.reset(seed=42)
    for _ in range(20):
        obs_a, reward_a, *_ = env_a.step(0)
        obs_b, reward_b, *_ = env_b.step(0)
        assert np.array_equal(obs_a, obs_b)
        assert reward_a == reward_b


def test_switching_phase_incurs_a_dead_time_throughput_penalty():
    # A phase switch pays real yellow+all-red clearance time in the live system (SignalPhaseMachine,
    # Phase 2) during which nothing is served — deducting that from the reward's throughput term
    # keeps a trained policy from having zero incentive against flip-flopping. Checked structurally
    # via info["deadTimePenalty"] rather than comparing raw reward across envs, since reward also
    # reflects which 2 of 4 approaches got served this step (a Poisson-noisy, action-dependent
    # quantity) and would make a reward-based comparison flaky.
    env = TrafficSignalEnv()
    env.reset(seed=7)
    _, _, _, _, info_stay = env.step(0)
    assert info_stay["deadTimePenalty"] == 0.0

    _, _, _, _, info_switch = env.step(1)
    assert info_switch["deadTimePenalty"] > 0.0
