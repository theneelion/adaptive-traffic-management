# Phase 6: RL Training Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Gymnasium-compatible traffic-signal environment, trained offline with PPO (Stable-Baselines3) on local hardware, exported to ONNX, evaluated against fixed seeded benchmarks before promotion (recorded in `models/manifest.json`), served from `ai-service` as a live, selectable alternative to Phase 2's rule-based controller (FR-10).

**Architecture — the one decision this phase must make explicit:** training an RL policy against the *real* Node/Matter.js simulation (driving it over HTTP for millions of PPO steps) is not practical — the round-trip and physics-tick cost would make training take unreasonably long for a local-hardware, non-distributed setup. Instead, `TrafficSignalEnv` is a **self-contained Python queueing-theory simulation** (Poisson arrivals, deterministic service-when-green, an abstracted jaywalk-risk term) that mirrors the *shape* of the real system's state (the same per-approach queue/wait and per-crossing pedestrian fields `SignalController` already sends) without running real physics. The trained policy is deployed against the *real* sim-server's actual measurements at inference time — ONNX inference only needs the observation vector's shape and meaning to match, not its origin. This is a standard and accepted sim-to-real gap for a portfolio-scale project; it is called out explicitly (not left implicit) because it means the eval gate (Task 6) validates the policy against the *training proxy*, not the live physics sim — final confidence still comes from Phase 10's manual/scenario play-testing against the real system, not from the eval gate alone.

**A second decision this phase corrects:** Phase 2's `phaseCandidates` field aggregates queue/wait *per phase group* (2 entries: NS/EW), which is coarse enough to lose the per-approach fairness signal the spec's reward function needs (`approach_wait_variance` is only meaningful computed across the 4 individual approaches, not 2 phase groups). This phase adds a second, finer-grained, additive field — `approachStates` (per approach) — used by the RL path; `rule_based.py`'s phase-level logic is untouched and keeps using `phaseCandidates`.

**Tech Stack:** Gymnasium, Stable-Baselines3 (PPO), PyTorch, ONNX + `onnxruntime`, NumPy — all new `ai-service` dependencies. Training runs locally (RTX 5090 mobile / Ultra 9 / 64GB primary, M4 16GB secondary — device auto-selected: CUDA → MPS → CPU).

**Spec:** [`traffic_ai_sim_technical_draft_FINAL.md`](../../traffic_ai_sim_technical_draft_FINAL.md) §2.2, §7, §14 step 6, FR-7, FR-10, TR-5, TR-6, TR-7, TR-8. Also read [`00-overview.md`](00-overview.md) §6 Phase-6 ledger entries. Also read [`02-signal-ai-v1.md`](02-signal-ai-v1.md) Task 3 (`rule_based.py`, `safety_wrapper.py`, `/signal-decision` route) and [`05-pedestrian-agents.md`](05-pedestrian-agents.md) Task 5 (`pedestrianCrossings`) — this phase extends the route and the request schema again.

## Global Constraints

- All Phase 1-5 Global Constraints still apply.
- The training-proxy/real-sim split above is binding: no task in this phase attempts to drive the real Node sim-server for training rollouts.
- `approachStates` is additive to `SignalDecisionRequest` — `rule_based.py` and every Phase 2 test are unaffected.
- Every trained checkpoint is evaluated before promotion; nothing merges into "deployed" state (`models/manifest.json` `promoted: true`) without passing the eval gate (TR-8, TR-12).

---

### Task 1: `signal-decision` schema — per-approach `approachStates` + `requestedController`

**Files:**
- Modify: `shared-contracts/schemas/signal-decision.schema.json`
- Modify: `sim-server/src/signals/SignalController.ts`
- Modify: `sim-server/test/signals/SignalController.test.ts`

**Interfaces:**
- Produces (Interface ledger, Phase 6): `SignalDecisionRequest.approachStates: [{ approachId: string; direction: "N"|"S"|"E"|"W"; queueLength: number; waitS: number }]`, `SignalDecisionRequest.requestedController?: "rule_based" | "rl"`.

- [ ] **Step 1: Extend the schema**

Modify `shared-contracts/schemas/signal-decision.schema.json` — add to `SignalDecisionRequest.properties` (not `required`, so Phase 2's existing calls remain valid):
```json
"approachStates": {
  "type": "array",
  "items": {
    "type": "object",
    "required": ["approachId", "direction", "queueLength", "waitS"],
    "properties": {
      "approachId": { "type": "string" },
      "direction": { "enum": ["N", "S", "E", "W"] },
      "queueLength": { "type": "integer", "minimum": 0 },
      "waitS": { "type": "number", "minimum": 0 }
    }
  }
},
"requestedController": { "enum": ["rule_based", "rl"] }
```
Also extend `SignalDecisionResponse.properties.controller`'s enum: `["rule_based", "rl"]` (was `["rule_based"]` since Phase 2).

Run: `pnpm --filter shared-contracts generate`

- [ ] **Step 2: Populate `approachStates` in `SignalController`**

Modify `sim-server/src/signals/SignalController.ts` — in `step()`, alongside the existing `phaseCandidates` construction, add:
```ts
const approachStates = Object.entries(APPROACH_DIRECTIONS).map(([approachId, direction]) => ({
  approachId,
  direction,
  ...this.detector.getApproachState(approachId)
}));
```
and include `approachStates` in the object passed to `this.client.decide({...})`. Also add a constructor parameter `requestedController: "rule_based" | "rl" = "rule_based"` (defaults preserve Phase 2 behavior) and include it in the request as `requestedController: this.requestedController`. Add a public `setRequestedController(mode: "rule_based" | "rl"): void` method so `SimSession` can flip it live (needed by Task 7's UI toggle).

- [ ] **Step 3: Extend the test**

Modify `sim-server/test/signals/SignalController.test.ts` — add:
```ts
it("includes per-approach state and the requested controller mode in the request", async () => {
  const client = { decide: vi.fn().mockResolvedValue({ phaseId: "NS_through", controller: "rule_based" }) };
  const detector = fakeDetector({ app_N: { queueLength: 2, waitS: 5 } });
  const controller = new SignalController(phases, client as any, detector, "int_1", undefined, undefined, "rl");

  await controller.step(1500);

  const sent = client.decide.mock.calls[0][0];
  expect(sent.requestedController).toBe("rl");
  const appN = sent.approachStates.find((a: any) => a.approachId === "app_N");
  expect(appN.queueLength).toBe(2);
});
```

- [ ] **Step 4: Run test to verify it passes, commit**

Run: `pnpm --filter sim-server test -- SignalController`
Expected: PASS (5 tests total across this file's history).

```bash
git add shared-contracts/schemas/signal-decision.schema.json shared-contracts/generated ai-service/app/contracts sim-server/src/signals/SignalController.ts sim-server/test/signals/SignalController.test.ts
git commit -m "feat(contracts): add per-approach approachStates and requestedController to signal-decision"
```

---

### Task 2: `reward.py` — multi-objective reward as a pure, tested function

**Files:**
- Create: `ai-service/app/reward.py`
- Test: `ai-service/tests/test_reward.py`

**Interfaces:**
- Produces (Interface ledger, Phase 6): `compute_reward(state: RewardInputs, weights: RewardWeights) -> float`.

- [ ] **Step 1: Write the failing test**

`ai-service/tests/test_reward.py`:
```python
from app.reward import compute_reward, RewardInputs, RewardWeights


def _state(**overrides) -> RewardInputs:
    base = dict(avg_vehicle_wait=0.0, approach_wait_variance=0.0, avg_pedestrian_wait=0.0, jaywalk_event_count=0, throughput=0.0)
    base.update(overrides)
    return RewardInputs(**base)


def test_higher_vehicle_wait_reduces_reward():
    weights = RewardWeights()
    low = compute_reward(_state(avg_vehicle_wait=1.0), weights)
    high = compute_reward(_state(avg_vehicle_wait=10.0), weights)
    assert high < low


def test_higher_throughput_increases_reward():
    weights = RewardWeights()
    low = compute_reward(_state(throughput=1.0), weights)
    high = compute_reward(_state(throughput=10.0), weights)
    assert high > low


def test_higher_wait_variance_reduces_reward_fairness_term():
    weights = RewardWeights()
    fair = compute_reward(_state(approach_wait_variance=0.0), weights)
    unfair = compute_reward(_state(approach_wait_variance=5.0), weights)
    assert unfair < fair


def test_jaywalk_events_reduce_reward():
    weights = RewardWeights()
    none = compute_reward(_state(jaywalk_event_count=0), weights)
    some = compute_reward(_state(jaywalk_event_count=3), weights)
    assert some < none


def test_zero_weights_yield_zero_reward_regardless_of_state():
    zero_weights = RewardWeights(w1=0, w2=0, w3=0, w4=0, w5=0)
    assert compute_reward(_state(avg_vehicle_wait=100, throughput=50), zero_weights) == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ai-service && uv run pytest tests/test_reward.py -v`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `reward.py`**

`ai-service/app/reward.py`:
```python
from dataclasses import dataclass


@dataclass
class RewardWeights:
    w1: float = 1.0  # avg vehicle wait
    w2: float = 0.5  # approach wait variance (fairness)
    w3: float = 1.0  # avg pedestrian wait
    w4: float = 2.0  # jaywalk event count
    w5: float = 0.3  # throughput


@dataclass
class RewardInputs:
    avg_vehicle_wait: float
    approach_wait_variance: float
    avg_pedestrian_wait: float
    jaywalk_event_count: int
    throughput: float


def compute_reward(state: RewardInputs, weights: RewardWeights) -> float:
    return (
        -(weights.w1 * state.avg_vehicle_wait)
        - (weights.w2 * state.approach_wait_variance)
        - (weights.w3 * state.avg_pedestrian_wait)
        - (weights.w4 * state.jaywalk_event_count)
        + (weights.w5 * state.throughput)
    )
```

Note: `w1..w5` defaults above are a starting point, not tuned values — spec §7 explicitly defers exact tuning to "once the Gym env exists" (Task 3 gives you that env; Task 4's training runs are where you'd actually adjust these based on observed policy behavior, e.g. if trained policies starve pedestrians, raise `w3`/`w4` relative to `w1`/`w5`).

- [ ] **Step 4: Run test to verify it passes, commit**

Run: `cd ai-service && uv run pytest tests/test_reward.py -v`
Expected: PASS (5 tests).

```bash
git add ai-service/app/reward.py ai-service/tests/test_reward.py
git commit -m "feat(ai-service): multi-objective reward function"
```

---

### Task 3: `TrafficSignalEnv` — Gymnasium environment (training proxy)

**Files:**
- Create: `ai-service/training/__init__.py`, `ai-service/training/env.py`
- Create: `ai-service/app/observation.py` (shared obs-vector construction — used by both the env and, in Task 5, real inference)
- Test: `ai-service/tests/test_env.py`
- Modify: `ai-service/pyproject.toml` (add `gymnasium`, `stable-baselines3`, `torch`, `onnx`, `onnxruntime`, `numpy`)

**Interfaces:**
- Produces (Interface ledger, Phase 6): `class TrafficSignalEnv(gymnasium.Env)`.
- Produces: `def build_observation_vector(approach_queues: dict[str, tuple[float, float]], phase_idx: int, num_phases: int, time_in_phase_s: float, ped_queues: dict[str, tuple[float, float]]) -> np.ndarray` — the single function both the training env and the real inference path (Task 5) call, so the vector layout can never silently drift between the two.

- [ ] **Step 1: Add training dependencies**

Modify `ai-service/pyproject.toml` — add to `dependencies`:
```toml
"gymnasium>=0.29.1",
"stable-baselines3>=2.3.2",
"torch>=2.4.0",
"onnx>=1.16.2",
"onnxruntime>=1.19.2",
"numpy>=2.0.0"
```

Run: `cd ai-service && uv sync`

- [ ] **Step 2: Write the failing test for `build_observation_vector`**

`ai-service/tests/test_observation.py`:
```python
import numpy as np
from app.observation import build_observation_vector, OBS_APPROACH_ORDER


def test_vector_length_matches_expected_layout():
    approach_queues = {a: (1.0, 2.0) for a in OBS_APPROACH_ORDER}
    ped_queues = {a: (0.0, 0.0) for a in OBS_APPROACH_ORDER}
    obs = build_observation_vector(approach_queues, phase_idx=0, num_phases=2, time_in_phase_s=3.0, ped_queues=ped_queues)
    # 4 approaches x 2 (queue,wait) + 2 phase one-hot + 1 time-in-phase + 4 crossings x 2 (queue,wait)
    assert obs.shape == (4 * 2 + 2 + 1 + 4 * 2,)


def test_phase_one_hot_reflects_current_phase():
    approach_queues = {a: (0.0, 0.0) for a in OBS_APPROACH_ORDER}
    ped_queues = {a: (0.0, 0.0) for a in OBS_APPROACH_ORDER}
    obs = build_observation_vector(approach_queues, phase_idx=1, num_phases=2, time_in_phase_s=0.0, ped_queues=ped_queues)
    phase_onehot_start = 4 * 2
    assert obs[phase_onehot_start] == 0.0
    assert obs[phase_onehot_start + 1] == 1.0


def test_is_deterministic_for_the_same_inputs():
    approach_queues = {a: (3.0, 4.0) for a in OBS_APPROACH_ORDER}
    ped_queues = {a: (1.0, 2.0) for a in OBS_APPROACH_ORDER}
    a = build_observation_vector(approach_queues, phase_idx=0, num_phases=2, time_in_phase_s=1.0, ped_queues=ped_queues)
    b = build_observation_vector(approach_queues, phase_idx=0, num_phases=2, time_in_phase_s=1.0, ped_queues=ped_queues)
    assert np.array_equal(a, b)
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ai-service && uv run pytest tests/test_observation.py -v`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `observation.py`**

`ai-service/app/observation.py`:
```python
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ai-service && uv run pytest tests/test_observation.py -v`
Expected: PASS (3 tests).

- [ ] **Step 6: Write the failing test for `TrafficSignalEnv`**

`ai-service/tests/test_env.py`:
```python
import numpy as np
from stable_baselines3.common.env_checker import check_env
from training.env import TrafficSignalEnv


def test_env_passes_sb3_env_checker():
    env = TrafficSignalEnv()
    check_env(env, warn=True)


def test_reset_returns_observation_of_expected_shape():
    env = TrafficSignalEnv()
    obs, info = env.reset(seed=1)
    assert obs.shape == env.observation_space.shape


def test_step_returns_five_tuple_and_advances_state():
    env = TrafficSignalEnv()
    env.reset(seed=1)
    obs, reward, terminated, truncated, info = env.step(0)
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
```

- [ ] **Step 7: Run test to verify it fails**

Run: `cd ai-service && uv run pytest tests/test_env.py -v`
Expected: FAIL, module not found.

- [ ] **Step 8: Implement `TrafficSignalEnv`**

`ai-service/training/env.py`:
```python
import gymnasium as gym
import numpy as np
from app.reward import compute_reward, RewardInputs, RewardWeights
from app.observation import build_observation_vector, OBS_APPROACH_ORDER

PHASE_APPROACHES = {
    "NS_through": {"app_N", "app_S"},
    "EW_through": {"app_E", "app_W"},
}
PHASE_IDS = list(PHASE_APPROACHES.keys())


class TrafficSignalEnv(gym.Env):
    metadata = {"render_modes": []}

    def __init__(
        self,
        arrival_rate_per_min: float = 20.0,
        ped_arrival_rate_per_min: float = 10.0,
        decision_interval_s: float = 1.5,
        episode_steps: int = 400,
        reward_weights: RewardWeights | None = None,
    ):
        super().__init__()
        self.arrival_rate_per_s = arrival_rate_per_min / 60.0
        self.ped_arrival_rate_per_s = ped_arrival_rate_per_min / 60.0
        self.service_rate_per_s = 0.5  # vehicles/s served on green, per approach
        self.ped_service_rate_per_s = 0.8
        self.jaywalk_queue_threshold = 4.0
        self.decision_interval_s = decision_interval_s
        self.episode_steps = episode_steps
        self.weights = reward_weights or RewardWeights()

        self.action_space = gym.spaces.Discrete(len(PHASE_IDS))
        obs_dim = len(OBS_APPROACH_ORDER) * 2 + len(PHASE_IDS) + 1 + len(OBS_APPROACH_ORDER) * 2
        self.observation_space = gym.spaces.Box(low=0, high=np.inf, shape=(obs_dim,), dtype=np.float32)

        self.rng = np.random.default_rng()
        self.queues: dict[str, float] = {}
        self.ped_queues: dict[str, float] = {}
        self.current_phase_idx = 0
        self.time_in_phase_s = 0.0
        self.step_count = 0

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        self.rng = np.random.default_rng(seed)
        self.queues = {a: 0.0 for a in OBS_APPROACH_ORDER}
        self.ped_queues = {a: 0.0 for a in OBS_APPROACH_ORDER}
        self.current_phase_idx = 0
        self.time_in_phase_s = 0.0
        self.step_count = 0
        return self._observe(), {}

    def step(self, action: int):
        if action != self.current_phase_idx:
            self.current_phase_idx = int(action)
            self.time_in_phase_s = 0.0
        else:
            self.time_in_phase_s += self.decision_interval_s

        green = PHASE_APPROACHES[PHASE_IDS[self.current_phase_idx]]
        jaywalk_events = 0

        for approach in OBS_APPROACH_ORDER:
            self.queues[approach] += self.rng.poisson(self.arrival_rate_per_s * self.decision_interval_s)
            if approach in green:
                served = min(self.queues[approach], self.service_rate_per_s * self.decision_interval_s)
                self.queues[approach] -= served

            self.ped_queues[approach] += self.rng.poisson(self.ped_arrival_rate_per_s * self.decision_interval_s)
            if approach not in green:
                crossed = min(self.ped_queues[approach], self.ped_service_rate_per_s * self.decision_interval_s)
                self.ped_queues[approach] -= crossed
            elif self.ped_queues[approach] > self.jaywalk_queue_threshold:
                jaywalk_events += 1
                self.ped_queues[approach] *= 0.8

        queue_values = list(self.queues.values())
        throughput = sum(
            min(self.queues[a], self.service_rate_per_s * self.decision_interval_s) for a in green
        )
        reward_inputs = RewardInputs(
            avg_vehicle_wait=float(np.mean(queue_values)),
            approach_wait_variance=float(np.var(queue_values)),
            avg_pedestrian_wait=float(np.mean(list(self.ped_queues.values()))),
            jaywalk_event_count=jaywalk_events,
            throughput=throughput,
        )
        reward = compute_reward(reward_inputs, self.weights)

        self.step_count += 1
        truncated = self.step_count >= self.episode_steps
        info = {
            "avg_wait": reward_inputs.avg_vehicle_wait,
            "avg_ped_wait": reward_inputs.avg_pedestrian_wait,
            "jaywalk_events": jaywalk_events,
            "throughput": throughput,
        }
        return self._observe(), reward, False, truncated, info

    def _observe(self) -> np.ndarray:
        approach_queues = {a: (self.queues[a], self.queues[a] / max(self.arrival_rate_per_s, 1e-6)) for a in OBS_APPROACH_ORDER}
        ped_queues = {a: (self.ped_queues[a], self.ped_queues[a] / max(self.ped_arrival_rate_per_s, 1e-6)) for a in OBS_APPROACH_ORDER}
        return build_observation_vector(
            approach_queues, self.current_phase_idx, len(PHASE_IDS), self.time_in_phase_s, ped_queues
        )
```

> **Deviation from the snippet above (see Risks section):** the actual implementation additionally deducts a fixed `dead_time_penalty_units = (YELLOW_S + ALL_RED_S) * service_rate_per_s` (`YELLOW_S = 3.0`, `ALL_RED_S = 1.5`, matching `SignalPhaseMachine`'s real timings) from `throughput` whenever `action != current_phase_idx`, and reports it as `info["deadTimePenalty"]`. This was originally written up as a deferred risk in an earlier draft of this plan but folded into Task 3 directly rather than left for later, since it's small, isolated to `step()`, and changes what a "good" policy looks like from the very first training run rather than after a checkpoint has already learned to flip-flop. `test_env.py` gained a sixth test, `test_switching_phase_incurs_a_dead_time_throughput_penalty`, checking `info["deadTimePenalty"]` structurally (0 when staying, >0 when switching) rather than comparing raw reward across two envs — a raw-reward comparison would be flaky since reward also reflects which 2 of 4 approaches happen to get served on a given Poisson-random step.

- [ ] **Step 9: Run test to verify it passes**

Run: `cd ai-service && uv run pytest tests/test_env.py -v`
Expected: PASS (5 tests). `check_env` from SB3 is the authoritative Gymnasium-API-compliance check (TR-6) — if it fails on space/dtype mismatches, fix `observation_space`/`action_space` declarations to match what `_observe()`/`step()` actually return.

- [ ] **Step 10: Commit**

```bash
git add ai-service/pyproject.toml ai-service/training ai-service/app/observation.py ai-service/tests/test_env.py ai-service/tests/test_observation.py
git commit -m "feat(ai-service): Gymnasium TrafficSignalEnv (training proxy) with shared observation-vector builder"
```

---

### Task 4: PPO training script

**Files:**
- Create: `ai-service/training/train.py`
- Test: `ai-service/tests/test_train_smoke.py`

**Interfaces:**
- Produces: `ai-service/training/train.py` runnable as `uv run python -m training.train --timesteps 200000 --out models/`, saving an SB3 `.zip` checkpoint plus metadata; no new importable interface beyond what Task 3 already defined (this is a script, run manually/on a schedule, not imported by the serving path).

- [ ] **Step 1: Write a training smoke test (tiny timestep count, checks it runs end-to-end without crashing)**

`ai-service/tests/test_train_smoke.py`:
```python
from training.train import train


def test_training_smoke_runs_a_handful_of_timesteps_without_error(tmp_path):
    result = train(total_timesteps=256, n_envs=2, out_dir=str(tmp_path), seed=1)
    assert result.model_path.exists()
    assert result.total_timesteps == 256
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ai-service && uv run pytest tests/test_train_smoke.py -v`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `train.py`**

`ai-service/training/train.py`:
```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ai-service && uv run pytest tests/test_train_smoke.py -v`
Expected: PASS. This test takes longer than the rest of the suite (spinning up 2 vec envs and running PPO for 256 steps) — acceptable for local/CI runs; if CI timing becomes a problem, mark it with a `@pytest.mark.slow` and exclude by default (Phase 8 revisits CI test categorization).

- [ ] **Step 5: Run a real local training pass (manual, on the 5090 box)**

Run: `cd ai-service && uv run python -m training.train --timesteps 200000 --out models`
Expected: completes in a few minutes on the RTX 5090 mobile (CUDA-selected); produces `models/ppo_traffic_signal.zip`. On the M4 (`mps` device), expect noticeably slower wall-clock but the same result — this is where the "primary/secondary hardware" split from the spec's decision log actually matters: use the 5090 box for any full training run, the M4 for quick iteration on `env.py`/`reward.py` changes.

- [ ] **Step 6: Commit**

```bash
git add ai-service/training/train.py ai-service/tests/test_train_smoke.py
git commit -m "feat(ai-service): PPO training script with CUDA/MPS/CPU auto-device-selection"
```

---

### Task 5: ONNX export + `RlPolicy` inference + route wiring

**Files:**
- Create: `ai-service/training/export_onnx.py`
- Create: `ai-service/app/rl_policy.py`
- Modify: `ai-service/app/routes.py` (branch on `requestedController`)
- Test: `ai-service/tests/test_export_onnx.py`
- Test: `ai-service/tests/test_rl_policy.py`
- Test: `ai-service/tests/test_signal_decision_route.py` (extend)

**Interfaces:**
- Produces (Interface ledger, Phase 6): `class RlPolicy` — `constructor(model_path: str)`, `.decide(obs: np.ndarray) -> int` (phase index).
- Produces: `def export_onnx(model: PPO, obs_dim: int, out_path: str) -> None`.

- [ ] **Step 1: Write the failing test for ONNX export**

`ai-service/tests/test_export_onnx.py`:
```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ai-service && uv run pytest tests/test_export_onnx.py -v`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `export_onnx`**

`ai-service/training/export_onnx.py`:
```python
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
        # the `onnxscript` package (not a dependency here) and silently ignores `dynamic_axes`
        # (documented as dynamo=False-only). Pin dynamo=False to keep the classic TorchScript-based
        # exporter this function is written against — found only by actually running this test
        # against the installed torch version, which raised `ModuleNotFoundError: onnxscript`.
        dynamo=False,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ai-service && uv run pytest tests/test_export_onnx.py -v`
Expected: PASS (with harmless deprecation warnings about the legacy TorchScript exporter — it still works, just superseded by the dynamo path as the new default).

- [ ] **Step 5: Write the failing test for `RlPolicy`**

`ai-service/tests/test_rl_policy.py`:
```python
import numpy as np
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
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd ai-service && uv run pytest tests/test_rl_policy.py -v`
Expected: FAIL, module not found.

- [ ] **Step 7: Implement `RlPolicy`**

`ai-service/app/rl_policy.py`:
```python
import numpy as np
import onnxruntime as ort


class RlPolicy:
    def __init__(self, model_path: str):
        self.session = ort.InferenceSession(model_path)

    def decide(self, obs: np.ndarray) -> int:
        logits = self.session.run(None, {"observation": obs.reshape(1, -1).astype(np.float32)})[0]
        return int(np.argmax(logits[0]))
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd ai-service && uv run pytest tests/test_rl_policy.py -v`
Expected: PASS.

- [ ] **Step 9: Wire `requestedController` into the `/signal-decision` route**

Modify `ai-service/app/routes.py`:
```python
from pathlib import Path
from fastapi import APIRouter
from app.contracts.signal_decision_schema import SignalDecisionRequest, SignalDecisionResponse
from app.rule_based import decide_phase
from app.safety_wrapper import apply_safety_constraints, PhaseDecision, IntersectionState, SafetyRules
from app.observation import build_observation_vector, OBS_APPROACH_ORDER
from app.rl_policy import RlPolicy

router = APIRouter()
PHASE_IDS = ["NS_through", "EW_through"]
_MODEL_PATH = Path(__file__).resolve().parents[2] / "models" / "promoted.onnx"
_rl_policy: RlPolicy | None = RlPolicy(str(_MODEL_PATH)) if _MODEL_PATH.exists() else None


@router.post("/signal-decision", response_model=SignalDecisionResponse)
def signal_decision(req: SignalDecisionRequest) -> SignalDecisionResponse:
    # Bug found during implementation: req.requestedController is a plain (non-str-mixin) pydantic
    # Enum once parsed — `RequestedController.rl == "rl"` is False (confirmed directly in a REPL
    # check), so the naive `req.requestedController == "rl"` comparison below is always False and
    # the RL branch would silently never activate regardless of what a client sends. Compare
    # against `.value` instead.
    requested = req.requestedController.value if req.requestedController is not None else None
    use_rl = requested == "rl" and _rl_policy is not None

    if use_rl:
        approach_queues = {a.approachId: (a.queueLength, a.waitS) for a in req.approachStates}
        ped_queues = {c.crossingId.replace("cross_", "app_"): (c.queueLength, c.waitS) for c in req.pedestrianCrossings}
        obs = build_observation_vector(
            approach_queues,
            phase_idx=PHASE_IDS.index(req.currentPhaseId),
            num_phases=len(PHASE_IDS),
            time_in_phase_s=req.timeInPhaseMs / 1000,
            ped_queues=ped_queues,
        )
        proposed = PhaseDecision(phase_id=PHASE_IDS[_rl_policy.decide(obs)], controller="rl")
    else:
        proposed = PhaseDecision(phase_id=decide_phase(req), controller="rule_based")

    state = IntersectionState(
        current_phase_id=req.currentPhaseId,
        time_in_phase_ms=req.timeInPhaseMs,
        all_phase_ids=[c.phaseId for c in req.phaseCandidates],
    )
    final = apply_safety_constraints(proposed, state, SafetyRules())
    return SignalDecisionResponse(phaseId=final.phase_id, controller=final.controller)
```

Note the `cross_` → `app_` id translation: Phase 5's crossing IDs (`cross_N`, etc.) intentionally mirror their approach IDs 1:1 for exactly this reason — the mapping is a fixed string substitution, not a lookup table, because `grid_1x1_v1`'s naming convention was chosen to make this trivial. If a future map uses different naming, this becomes a small map-driven lookup instead of string substitution — not a redesign.

- [ ] **Step 10: Extend the route test for the RL path**

Add to `ai-service/tests/test_signal_decision_route.py`:
```python
def test_signal_decision_falls_back_to_rule_based_when_no_promoted_model_exists():
    # No models/promoted.onnx in the test environment -> requestedController="rl" still falls back safely.
    response = client.post(
        "/signal-decision",
        json={
            "intersectionId": "int_1",
            "currentPhaseId": "NS_through",
            "timeInPhaseMs": 5000,
            "phaseCandidates": [
                {"phaseId": "NS_through", "queueLength": 0, "waitS": 0.0},
                {"phaseId": "EW_through", "queueLength": 6, "waitS": 15.0},
            ],
            "approachStates": [],
            "pedestrianCrossings": [],
            "requestedController": "rl",
        },
    )
    assert response.status_code == 200
    assert response.json()["controller"] == "rule_based"
```

Also add a test that actually exercises the RL-active branch (not just the fallback), to catch the enum-comparison bug above — the fallback test alone passes regardless of whether that comparison is fixed, since both `_rl_policy is None` and a broken `requested == "rl"` check lead to the same rule_based result. Inject a fake policy via `monkeypatch.setattr(routes_module, "_rl_policy", fake)` (bypassing the module-level "does `models/promoted.onnx` exist on disk" check) rather than writing a real trained checkpoint to disk for the test — the routing logic being tested doesn't care what produced the ONNX inference result. Send fully-populated `approachStates`/`pedestrianCrossings` (4 entries each — `build_observation_vector` indexes every `OBS_APPROACH_ORDER` entry unconditionally and raises `KeyError` on a partial or empty list) and assert `body["controller"] == "rl"`.

- [ ] **Step 11: Run the full `ai-service` suite, commit**

Run: `cd ai-service && uv run pytest -v`
Expected: PASS.

```bash
git add ai-service/training/export_onnx.py ai-service/app/rl_policy.py ai-service/app/routes.py ai-service/tests
git commit -m "feat(ai-service): ONNX export, RlPolicy inference, and RL/rule-based route branching"
```

---

### Task 6: Eval gate + `models/manifest.json` + `rl-regression` CI job

**Files:**
- Create: `ai-service/training/eval_gate.py`
- Create: `models/manifest.json` (initial, empty)
- Test: `ai-service/tests/test_eval_gate.py`
- Modify: `.github/workflows/ci.yml` (add `rl-regression` job — `00-overview.md` §5 phase-6 row)

**Interfaces:**
- Produces: `def evaluate_checkpoint(onnx_path: str, benchmark_seeds: list[int], episode_steps: int = 200) -> EvalScores`, `def check_regression(candidate: EvalScores, baseline: EvalScores | None, thresholds: RegressionThresholds) -> bool` (returns `True` if the candidate is acceptable — no metric regressed past its threshold).

- [ ] **Step 1: Write the failing test**

`ai-service/tests/test_eval_gate.py`:
```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ai-service && uv run pytest tests/test_eval_gate.py -v`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `eval_gate.py`**

`ai-service/training/eval_gate.py`:
```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ai-service && uv run pytest tests/test_eval_gate.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Create the initial (empty) manifest**

`models/manifest.json`:
```json
{
  "checkpoints": []
}
```

- [ ] **Step 6: Write the CLI entrypoint that CI actually runs**

Append to `ai-service/training/eval_gate.py`:
```python
if __name__ == "__main__":
    import argparse
    import json
    import shutil
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
```

Note: `trainedAt` from the Interface ledger's manifest schema (`00-overview.md` §6) is intentionally omitted from this write — this workflow-authoring context cannot call `datetime.now()`/`Date.now()` without breaking replayability, but the **real** `eval_gate.py` module has no such restriction; add `"trainedAt": datetime.now(UTC).isoformat()` (with `from datetime import UTC, datetime`) to the appended dict when actually implementing this file (call it out here so the implementer doesn't drop the field the ledger promises). Use `datetime.UTC`, not `datetime.timezone.utc` — ruff's UP017 flags the latter as the deprecated spelling and `unit-py`'s CI job runs `ruff check .`.

- [ ] **Step 7: Add the `rl-regression` CI job**

Append to `.github/workflows/ci.yml`:
```yaml
  rl-regression:
    runs-on: ubuntu-latest
    if: contains(github.event.head_commit.modified, 'models/manifest.json') || contains(github.event.head_commit.modified, 'ai-service/training/')
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install uv
      - run: cd ai-service && uv sync
      - name: Train a candidate checkpoint
        run: cd ai-service && uv run python -m training.train --timesteps 50000 --out /tmp/candidate
      - name: Export candidate to ONNX
        run: |
          cd ai-service && uv run python -c "
          from stable_baselines3 import PPO
          from training.export_onnx import export_onnx
          from training.env import TrafficSignalEnv
          model = PPO.load('/tmp/candidate/ppo_traffic_signal.zip')
          export_onnx(model, obs_dim=TrafficSignalEnv().observation_space.shape[0], out_path='/tmp/candidate/model.onnx')
          "
      - name: Evaluate against the currently promoted checkpoint
        run: cd ai-service && uv run python -m training.eval_gate --candidate /tmp/candidate/model.onnx --manifest ../models/manifest.json --models-dir ../models
```

Note the `if:` condition uses the simplest available signal (`github.event.head_commit.modified`) rather than a dedicated path-filter action, keeping this job dependency-free; Phase 8's CI hardening pass is the right place to replace it with `dorny/paths-filter` or similar if the simple form proves unreliable across PR vs. push event shapes.

- [ ] **Step 8: Commit**

```bash
git add ai-service/training/eval_gate.py ai-service/tests/test_eval_gate.py models/manifest.json .github/workflows/ci.yml
git commit -m "feat(ai-service): eval gate with regression thresholds; wire rl-regression CI job"
```

---

### Task 7: Classical/RL toggle in the frontend

**Files:**
- Modify: `shared-contracts/schemas/client-input.schema.json` — **not modified**; the toggle is a distinct message, not part of driving input
- Create: `shared-contracts/schemas/controller-mode.schema.json`
- Modify: `sim-server/src/server.ts` (handle the new message type, forward to `SimSession`)
- Modify: `sim-server/src/room/SimSession.ts` (add `setControllerMode`)
- Modify: `frontend/src/scenes/MainScene.ts` (a toggle button + label showing current mode)
- Test: `sim-server/test/room/SimSession.test.ts` (extend)

**Interfaces:**
- Produces: `ControllerModeMessage = { type: "controller_mode"; payload: { mode: "rule_based" | "rl" }; ts: number }`.

- [ ] **Step 1: Add the schema**

`shared-contracts/schemas/controller-mode.schema.json`:
```json
{
  "$id": "ControllerModeMessage",
  "type": "object",
  "required": ["type", "payload", "ts"],
  "properties": {
    "type": { "const": "controller_mode" },
    "ts": { "type": "number" },
    "payload": {
      "type": "object",
      "required": ["mode"],
      "properties": { "mode": { "enum": ["rule_based", "rl"] } }
    }
  }
}
```

Run: `pnpm --filter shared-contracts generate`

- [ ] **Step 2: Add `setControllerMode` to `SimSession` and extend its test**

Modify `sim-server/src/room/SimSession.ts` — add:
```ts
setControllerMode(mode: "rule_based" | "rl"): void {
  this.signalController.setRequestedController(mode);
}
```

Add to `sim-server/test/room/SimSession.test.ts`:
```ts
it("forwards a controller mode change to SignalController", async () => {
  // SignalController only calls the AI client once per accumulated 1500ms decision interval
  // (Phase 2), not on every 50ms tick — found by actually running this test with a single
  // session.step() call (as an earlier draft had it) and seeing `.mock.calls.at(-1)` be
  // undefined, since no decision request had gone out yet. Step enough ticks (40 x 50ms =
  // 2000ms > 1500ms) to guarantee at least one decision request goes out.
  const session = new SimSession("../../maps/grid_1x1_v1.json", store, "http://fake", 120, 4);
  session.setControllerMode("rl");
  for (let i = 0; i < 40; i++) await session.step();
  const sentRequest = (global.fetch as any).mock.calls.at(-1)[1];
  const body = JSON.parse(sentRequest.body);
  expect(body.requestedController).toBe("rl");
});
```

- [ ] **Step 3: Route the message in `server.ts`**

Modify `sim-server/src/server.ts` — in the `socket.on("message", ...)` handler, add a branch:
```ts
if (msg.type === "controller_mode") {
  session.setControllerMode(msg.payload.mode);
}
```

- [ ] **Step 4: Add a toggle button to the frontend**

Modify `frontend/src/scenes/MainScene.ts` — in `create()`, add:
```ts
const modeLabel = this.add.text(this.scale.width - 160, 10, "Mode: rule_based", { fontSize: "14px", color: "#ffffff" });
let mode: "rule_based" | "rl" = "rule_based";
const toggleButton = this.add.text(this.scale.width - 160, 30, "[toggle AI mode]", { fontSize: "14px", color: "#88ccff" })
  .setInteractive();
toggleButton.on("pointerdown", () => {
  mode = mode === "rule_based" ? "rl" : "rule_based";
  modeLabel.setText(`Mode: ${mode}`);
  this.client.sendControllerMode(mode);
});
```

Modify `frontend/src/net/SimClient.ts` — add:
```ts
sendControllerMode(mode: "rule_based" | "rl"): void {
  this.socket.send(JSON.stringify({ type: "controller_mode", ts: Date.now(), payload: { mode } }));
}
```

- [ ] **Step 5: Run the full sim-server and frontend suites, commit**

Run: `pnpm --filter sim-server test && pnpm --filter frontend test`
Expected: PASS.

```bash
git add shared-contracts/schemas/controller-mode.schema.json shared-contracts/generated ai-service/app/contracts sim-server/src/room/SimSession.ts sim-server/src/server.ts sim-server/test/room/SimSession.test.ts frontend/src/scenes/MainScene.ts frontend/src/net/SimClient.ts
git commit -m "feat: classical/RL controller mode toggle, end-to-end from frontend button to ai-service"
```

---

## Testing summary (maps to spec §11)

| Layer | Covered in this phase? | What |
|---|---|---|
| Unit | Yes | `compute_reward`, `build_observation_vector`, `TrafficSignalEnv` (SB3 `check_env` + determinism), `export_onnx`, `RlPolicy`, `evaluate_checkpoint`/`check_regression` |
| Integration | Extended | `/signal-decision` route test now covers the RL branch (falls back safely with no promoted model) |
| Physics/determinism | Unaffected | RL training doesn't touch the Matter.js sim |
| Load | Not yet | Phase 8 |
| RL regression (eval gate) | Yes — first entry | `rl-regression` CI job, conditional on `models/`/`training/` changes |
| E2E | Manual only | Toggle AI mode in the browser, observe signal behavior visibly change between rule-based and RL |

## Definition of Done

- [ ] A full local training run on the 5090 box (or M4, slower) produces a `.onnx` checkpoint. **Not done as part of this implementation pass** — verified the mechanics with a 128-256 timestep smoke-scale run only (train → export_onnx → eval_gate CLI → manifest/promoted.onnx all worked end-to-end and were then cleaned up as throwaway artifacts); a real `--timesteps 200000` run is explicitly a manual step for the user to run on their own hardware per Task 4 Step 5.
- [x] `eval_gate.py` runs against that checkpoint and updates `models/manifest.json`; a checkpoint promoted this way is copied to `models/promoted.onnx`. Verified end-to-end via the CLI entrypoint against a smoke-scale checkpoint; manifest/onnx artifacts were reset to the initial empty state afterward since the model itself was junk.
- [ ] `rl-regression` CI job is green — YAML syntax validated (parses, all 6 jobs present) but not exercised against a real GitHub Actions run in this session.
- [ ] Toggling the frontend button switches `ai-service`'s decision source live — implemented, typechecked, and unit-tested (`SimSession` forwards mode to `SignalController`, which threads it into every request; the route's RL branch is unit-tested with an injected fake policy) but not manually observed in a live browser session this pass.
- [x] `/signal-decision` never 500s when `requestedController: "rl"` is sent but no promoted model exists yet (falls back to `rule_based`) — plus a stronger regression test added beyond the plan's original scope, since the fallback test alone can't catch the enum-comparison bug found during implementation (see Task 5).
- [x] Every file/signature in the Interface ledger's "From Phase 6" section (`00-overview.md` §6) exists, including the two corrections from this phase's Task 1 (`approachStates`, `requestedController`) — checked directly against the ledger; no discrepancies found.

## Risks / open implementation notes

- **The training/serving simulation gap is the single biggest fidelity risk in this whole system.** `TrafficSignalEnv`'s queueing-theory dynamics are a deliberate simplification of the real Matter.js + IDM + pedestrian-steering behavior; a policy that performs well in `eval_gate.py` is not guaranteed to perform well against the real sim's messier dynamics (e.g., IDM's car-following jitter, actual multi-vehicle blocking at the intersection, real jaywalk timing). Phase 10's manual scenario testing against the live system is where this gap actually gets checked — treat the eval gate as "did this checkpoint get strictly worse at the thing we can cheaply measure," not "is this checkpoint good in production."
- **Ruff lint fixes needed on this phase's literal snippets** (found by actually running `uv run ruff check .`, which `unit-py`'s CI job does): `test_env.py`'s unused `info`/`obs, info = ...` unpacked variables need an underscore prefix (`_info`) — RUF059; `test_reward.py`'s `_state()` helper's `dict(...)` call needs to be a `{...}` literal — C408; `TrafficSignalEnv.metadata = {"render_modes": []}` needs a `ClassVar[dict]` annotation (mutable class-attribute default) — RUF012, requiring `from typing import ClassVar`. None of these change behavior; apply them as written or `unit-py` fails on this phase's very first commit.
- Reward weight defaults (`RewardWeights`) are untuned placeholders per spec §7's own instruction — expect to revisit them after watching a few trained policies play out, not before.
- `service_rate_per_s`/`ped_service_rate_per_s`/`jaywalk_queue_threshold` in `TrafficSignalEnv` are hand-picked constants with no calibration against the real sim's actual throughput — if trained behavior looks obviously wrong when finally run against the live system (Phase 10), recalibrating these against real sim-server telemetry (captured KPI snapshots) is the fix, not a training-algorithm change.
- **Implemented during this phase, not left as flagged debt:** an earlier draft of this plan flagged that `TrafficSignalEnv` switches phases with zero transition cost as a risk to fix later. Implemented directly in Task 3 instead: `step()` deducts a fixed `(YELLOW_S + ALL_RED_S) * service_rate_per_s` "dead time" from the throughput term whenever `action != current_phase_idx`, and reports it as `info["deadTimePenalty"]` so it's structurally testable (`test_switching_phase_incurs_a_dead_time_throughput_penalty` in `test_env.py`) without the test being sensitive to which 2 of 4 approaches happen to get served on a given Poisson-random step. This favors fewer, longer phases, matching the real system's actual clearance-time cost from day one of training rather than after a first checkpoint already learned to flip-flop.
