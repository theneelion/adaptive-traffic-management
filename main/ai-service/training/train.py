import argparse
from dataclasses import dataclass
from pathlib import Path

import torch
from stable_baselines3 import PPO
from stable_baselines3.common.env_util import make_vec_env

from training.env import TrafficSignalEnv


def select_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


@dataclass
class TrainResult:
    model_path: Path
    total_timesteps: int


def train(total_timesteps: int, n_envs: int, out_dir: str, seed: int = 0) -> TrainResult:
    out_path = Path(out_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    vec_env = make_vec_env(TrafficSignalEnv, n_envs=n_envs, seed=seed)
    model = PPO("MlpPolicy", vec_env, verbose=0, device=select_device(), seed=seed)
    model.learn(total_timesteps=total_timesteps)

    model_path = out_path / "ppo_traffic_signal.zip"
    model.save(str(model_path))
    return TrainResult(model_path=model_path, total_timesteps=total_timesteps)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--timesteps", type=int, default=200_000)
    parser.add_argument("--n-envs", type=int, default=8)
    parser.add_argument("--out", type=str, default="models")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    result = train(total_timesteps=args.timesteps, n_envs=args.n_envs, out_dir=args.out, seed=args.seed)
    print(f"Saved checkpoint to {result.model_path} ({result.total_timesteps} timesteps)")
