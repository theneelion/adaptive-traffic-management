import numpy as np
import onnxruntime as ort


class RlPolicy:
    def __init__(self, model_path: str):
        self.session = ort.InferenceSession(model_path)

    def decide(self, obs: np.ndarray) -> int:
        logits = self.session.run(None, {"observation": obs.reshape(1, -1).astype(np.float32)})[0]
        return int(np.argmax(logits[0]))
