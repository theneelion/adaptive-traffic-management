from stable_baselines3 import PPO
from training.env import TrafficSignalEnv
from training.export_onnx import export_onnx
from app.rl_policy import RlPolicy


def test_rl_policy_returns_a_valid_phase_index(tmp_path):
    env = TrafficSignalEnv()
    model = PPO("MlpPolicy", env, verbose=0)
    model.learn(total_timesteps=64)
    out_path = tmp_path / "model.onnx"
    export_onnx(model, obs_dim=env.observation_space.shape[0], out_path=str(out_path))

    policy = RlPolicy(str(out_path))
    obs, _ = env.reset(seed=1)
    action = policy.decide(obs)
    assert action in range(env.action_space.n)
