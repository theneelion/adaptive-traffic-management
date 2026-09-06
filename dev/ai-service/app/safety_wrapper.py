from dataclasses import dataclass


@dataclass
class PhaseDecision:
    phase_id: str
    controller: str  # "rule_based" (Phase 2) | "rl" (Phase 6)


@dataclass
class IntersectionState:
    current_phase_id: str
    time_in_phase_ms: float
    all_phase_ids: list[str]


@dataclass
class SafetyRules:
    min_green_ms: float = 4000
    max_green_ms: float = 20000


def apply_safety_constraints(proposed: PhaseDecision, state: IntersectionState, rules: SafetyRules) -> PhaseDecision:
    if proposed.phase_id != state.current_phase_id and state.time_in_phase_ms < rules.min_green_ms:
        return PhaseDecision(phase_id=state.current_phase_id, controller=proposed.controller)

    if proposed.phase_id == state.current_phase_id and state.time_in_phase_ms >= rules.max_green_ms:
        idx = state.all_phase_ids.index(state.current_phase_id)
        next_phase = state.all_phase_ids[(idx + 1) % len(state.all_phase_ids)]
        return PhaseDecision(phase_id=next_phase, controller=proposed.controller)

    return proposed
