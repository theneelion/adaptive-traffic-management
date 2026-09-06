import pytest
from training.train import train


@pytest.mark.slow
def test_training_smoke_runs_a_handful_of_timesteps_without_error(tmp_path):
    result = train(total_timesteps=256, n_envs=2, out_dir=str(tmp_path), seed=1)
    assert result.model_path.exists()
    assert result.total_timesteps == 256
