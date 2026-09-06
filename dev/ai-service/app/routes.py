from pathlib import Path
from fastapi import APIRouter
from app.contracts.signal_decision_schema import SignalDecisionRequest, SignalDecisionResponse
from app.rule_based import decide_phase
from app.safety_wrapper import apply_safety_constraints, PhaseDecision, IntersectionState, SafetyRules
from app.observation import build_observation_vector
from app.rl_policy import RlPolicy
from app.ev_override import apply_ev_override, EvContext

router = APIRouter()
PHASE_IDS = ["NS_through", "EW_through"]
_MODEL_PATH = Path(__file__).resolve().parents[2] / "models" / "promoted.onnx"
_rl_policy: RlPolicy | None = RlPolicy(str(_MODEL_PATH)) if _MODEL_PATH.exists() else None


@router.post("/signal-decision", response_model=SignalDecisionResponse)
def signal_decision(req: SignalDecisionRequest) -> SignalDecisionResponse:
    # req.requestedController is a plain (non-str-mixin) Enum once pydantic parses it, so
    # `== "rl"` is always False — compare against .value instead. Found only by checking the
    # generated enum's equality behavior directly; a silent version of this bug would mean the
    # RL branch never activates regardless of what the client requests.
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

    ev_context = (
        EvContext(ev_id=req.evContext.evId, eta_s=req.evContext.etaS, required_phase_id=req.evContext.requiredPhaseId)
        if req.evContext is not None
        else None
    )
    final = apply_ev_override(final, ev_context)
    return SignalDecisionResponse(phaseId=final.phase_id, controller=final.controller)
