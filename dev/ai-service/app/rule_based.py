from app.contracts.signal_decision_schema import SignalDecisionRequest

MIN_ADVANTAGE_RATIO = 1.5
NEIGHBOR_BOOST = 0.5  # added to the challenger's pressure when a neighbor just fed it fresh flow
NEIGHBOR_FRESH_MS = 3000  # a neighbor phase is "just switched" within this long of its own start


def decide_phase(req: SignalDecisionRequest) -> str:
    current = next(c for c in req.phaseCandidates if c.phaseId == req.currentPhaseId)
    best = max(req.phaseCandidates, key=lambda c: c.queueLength + c.waitS)

    current_pressure = current.queueLength + current.waitS
    best_pressure = best.queueLength + best.waitS

    # Basic green-wave heuristic (spec §8.2): if any neighboring intersection just turned green
    # (within NEIGHBOR_FRESH_MS of its own phase start), that flow is about to arrive here — nudge
    # this intersection toward being ready to receive it by inflating whichever candidate phase
    # isn't the current one. Deliberately simple (no lane-level flow modeling, no knowledge of
    # *which* approach the neighbor's flow feeds into) — a hand-written bias, not a learned policy;
    # the coordinated RL policy (a later stage) supersedes this with real inter-intersection
    # structure.
    neighbors = req.neighborIntersections or []
    neighbor_just_switched = any(n.timeInPhaseMs < NEIGHBOR_FRESH_MS for n in neighbors)
    if neighbor_just_switched and best.phaseId != current.phaseId:
        best_pressure += NEIGHBOR_BOOST

    if best.phaseId == current.phaseId:
        return current.phaseId
    if current_pressure == 0 or best_pressure > current_pressure * MIN_ADVANTAGE_RATIO:
        return best.phaseId
    return current.phaseId
