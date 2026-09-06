from stable_baselines3 import PPO
from training.env import TrafficSignalEnv
from training.export_onnx import export_onnx
from training.eval_gate import evaluate_checkpoint, check_regression, EvalScores, RegressionThresholds


def test_evaluate_checkpoint_returns_scores_for_fixed_seeds(tmp_path):
    env = TrafficSignalEnv()
    model = PPO("MlpPolicy", env, verbose=0)
    model.learn(total_timesteps=64)
    path = tmp_path / "model.onnx"
    export_onnx(model, obs_dim=env.observation_space.shape[0], out_path=str(path))

    scores = evaluate_checkpoint(str(path), benchmark_seeds=[1, 2, 3], episode_steps=20)
    assert scores.avg_vehicle_wait >= 0
    assert scores.avg_pedestrian_wait >= 0
    assert scores.throughput >= 0


def test_check_regression_passes_with_no_baseline():
    candidate = EvalScores(avg_vehicle_wait=5.0, avg_pedestrian_wait=3.0, jaywalk_events=1.0, throughput=10.0)
    assert check_regression(candidate, None, RegressionThresholds()) is True


def test_check_regression_fails_when_wait_regresses_past_threshold():
    baseline = EvalScores(avg_vehicle_wait=5.0, avg_pedestrian_wait=3.0, jaywalk_events=1.0, throughput=10.0)
    candidate = EvalScores(avg_vehicle_wait=20.0, avg_pedestrian_wait=3.0, jaywalk_events=1.0, throughput=10.0)
    assert check_regression(candidate, baseline, RegressionThresholds(max_wait_regression_pct=10.0)) is False


def test_check_regression_passes_within_threshold():
    baseline = EvalScores(avg_vehicle_wait=5.0, avg_pedestrian_wait=3.0, jaywalk_events=1.0, throughput=10.0)
    candidate = EvalScores(avg_vehicle_wait=5.2, avg_pedestrian_wait=3.0, jaywalk_events=1.0, throughput=10.0)
    assert check_regression(candidate, baseline, RegressionThresholds(max_wait_regression_pct=10.0)) is True
