import onnxruntime as ort
import numpy as np
from stable_baselines3 import PPO
from training.env import TrafficSignalEnv
from training.export_onnx import export_onnx


def test_exported_model_runs_inference_and_matches_observation_shape(tmp_path):
    env = TrafficSignalEnv()
    model = PPO("MlpPolicy", env, verbose=0)
    model.learn(total_timesteps=64)  # just enough to have a real forward pass, not a trained policy

    out_path = tmp_path / "model.onnx"
    export_onnx(model, obs_dim=env.observation_space.shape[0], out_path=str(out_path))

    session = ort.InferenceSession(str(out_path))
    obs, _ = env.reset(seed=1)
    logits = session.run(None, {"observation": obs.reshape(1, -1).astype(np.float32)})[0]
    assert logits.shape[1] == env.action_space.n
