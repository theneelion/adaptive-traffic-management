import numpy as np

OBS_APPROACH_ORDER = ["app_N", "app_S", "app_E", "app_W"]


def build_observation_vector(
    approach_queues: dict[str, tuple[float, float]],
    phase_idx: int,
    num_phases: int,
    time_in_phase_s: float,
    ped_queues: dict[str, tuple[float, float]],
) -> np.ndarray:
    values: list[float] = []
    for approach in OBS_APPROACH_ORDER:
        queue_length, wait_s = approach_queues[approach]
        values.append(float(queue_length))
        values.append(float(wait_s))

    values.extend(1.0 if i == phase_idx else 0.0 for i in range(num_phases))
    values.append(float(time_in_phase_s))

    for approach in OBS_APPROACH_ORDER:
        queue_length, wait_s = ped_queues[approach]
        values.append(float(queue_length))
        values.append(float(wait_s))

    return np.array(values, dtype=np.float32)
