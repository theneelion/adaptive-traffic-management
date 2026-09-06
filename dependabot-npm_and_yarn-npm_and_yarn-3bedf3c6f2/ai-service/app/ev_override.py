from dataclasses import dataclass
from app.safety_wrapper import PhaseDecision

PREEMPT_WINDOW_S = 10.0


@dataclass
class EvContext:
    ev_id: str
    eta_s: float
    required_phase_id: str


def apply_ev_override(decision: PhaseDecision, ev_context: EvContext | None) -> PhaseDecision:
    if ev_context is None or ev_context.eta_s > PREEMPT_WINDOW_S:
        return decision
    return PhaseDecision(phase_id=ev_context.required_phase_id, controller=decision.controller)
