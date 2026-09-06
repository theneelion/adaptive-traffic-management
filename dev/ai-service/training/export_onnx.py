import torch
from stable_baselines3 import PPO


class _OnnxPolicyWrapper(torch.nn.Module):
    def __init__(self, policy):
        super().__init__()
        self.policy = policy

    def forward(self, observation: torch.Tensor) -> torch.Tensor:
        distribution = self.policy.get_distribution(observation)
        return distribution.distribution.logits


def export_onnx(model: PPO, obs_dim: int, out_path: str) -> None:
    wrapper = _OnnxPolicyWrapper(model.policy).eval()
    dummy_input = torch.zeros(1, obs_dim)
    torch.onnx.export(
        wrapper,
        dummy_input,
        out_path,
        input_names=["observation"],
        output_names=["action_logits"],
        opset_version=17,
        dynamic_axes={"observation": {0: "batch"}},
        # torch>=2.6 defaults `dynamo=True` (the new torch.export-based exporter), which requires
        # the `onnxscript` package and ignores `dynamic_axes` (that kwarg is dynamo=False-only,
        # per torch.onnx.export's own docstring). Pinning dynamo=False keeps the classic
        # TorchScript-based exporter this function was written against, with no new dependency.
        dynamo=False,
    )
