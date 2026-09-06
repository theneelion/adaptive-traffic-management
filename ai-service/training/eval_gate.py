from dataclasses import dataclass
import numpy as np
from training.env import TrafficSignalEnv
from app.rl_policy import RlPolicy


@dataclass
class EvalScores:
    avg_vehicle_wait: float
    avg_pedestrian_wait: float
    jaywalk_events: float
    throughput: float


@dataclass
class RegressionThresholds:
    max_wait_regression_pct: float = 10.0
    max_ped_wait_regression_pct: float = 10.0
    max_jaywalk_regression_pct: float = 15.0
    max_throughput_drop_pct: float = 10.0


def evaluate_checkpoint(onnx_path: str, benchmark_seeds: list[int], episode_steps: int = 200) -> EvalScores:
    policy = RlPolicy(onnx_path)
    waits, ped_waits, jaywalks, throughputs = [], [], [], []

    for seed in benchmark_seeds:
        env = TrafficSignalEnv(episode_steps=episode_steps)
        obs, _ = env.reset(seed=seed)
        for _ in range(episode_steps):
            action = policy.decide(obs)
            obs, _, terminated, truncated, info = env.step(action)
            waits.append(info["avg_wait"])
            ped_waits.append(info["avg_ped_wait"])
            jaywalks.append(info["jaywalk_events"])
            throughputs.append(info["throughput"])
            if terminated or truncated:
                break

    return EvalScores(
        avg_vehicle_wait=float(np.mean(waits)),
        avg_pedestrian_wait=float(np.mean(ped_waits)),
        jaywalk_events=float(np.mean(jaywalks)),
        throughput=float(np.mean(throughputs)),
    )


def check_regression(candidate: EvalScores, baseline: EvalScores | None, thresholds: RegressionThresholds) -> bool:
    if baseline is None:
        return True

    def regressed(candidate_value: float, baseline_value: float, max_pct: float, lower_is_better: bool) -> bool:
        if baseline_value == 0:
            return False
        pct_change = (candidate_value - baseline_value) / abs(baseline_value) * 100
        if lower_is_better:
            return pct_change > max_pct
        return pct_change < -max_pct

    return not (
        regressed(candidate.avg_vehicle_wait, baseline.avg_vehicle_wait, thresholds.max_wait_regression_pct, True)
        or regressed(candidate.avg_pedestrian_wait, baseline.avg_pedestrian_wait, thresholds.max_ped_wait_regression_pct, True)
        or regressed(candidate.jaywalk_events, baseline.jaywalk_events, thresholds.max_jaywalk_regression_pct, True)
        or regressed(candidate.throughput, baseline.throughput, thresholds.max_throughput_drop_pct, False)
    )


if __name__ == "__main__":
    import argparse
    import json
    import shutil
    from datetime import UTC, datetime
    from pathlib import Path

    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", required=True, help="Path to candidate .onnx")
    parser.add_argument("--manifest", default="../models/manifest.json")
    parser.add_argument("--models-dir", default="../models")
    args = parser.parse_args()

    manifest_path = Path(args.manifest)
    manifest = json.loads(manifest_path.read_text())
    promoted = next((c for c in manifest["checkpoints"] if c["promoted"]), None)

    candidate_scores = evaluate_checkpoint(args.candidate, benchmark_seeds=[1, 2, 3, 4, 5])
    baseline_scores = (
        EvalScores(**promoted["evalScores"]) if promoted else None
    )

    ok = check_regression(candidate_scores, baseline_scores, RegressionThresholds())

    checkpoint_id = f"ckpt_{len(manifest['checkpoints']) + 1}"
    dest_path = Path(args.models_dir) / f"{checkpoint_id}.onnx"
    shutil.copy(args.candidate, dest_path)

    manifest["checkpoints"].append(
        {
            "id": checkpoint_id,
            "path": str(dest_path.name),
            "trainedAt": datetime.now(UTC).isoformat(),
            "evalScores": candidate_scores.__dict__,
            "promoted": ok,
        }
    )
    if ok:
        for c in manifest["checkpoints"][:-1]:
            c["promoted"] = False
        shutil.copy(dest_path, Path(args.models_dir) / "promoted.onnx")

    manifest_path.write_text(json.dumps(manifest, indent=2))

    if not ok:
        raise SystemExit(f"Checkpoint {checkpoint_id} regressed past threshold vs. {promoted['id'] if promoted else 'n/a'}")
