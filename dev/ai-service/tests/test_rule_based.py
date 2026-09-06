from app.contracts.signal_decision_schema import SignalDecisionRequest, PhaseCandidate, NeighborIntersection
from app.rule_based import decide_phase


def _req(current: str, candidates: list[tuple[str, int, float]], neighbors: list[NeighborIntersection] | None = None) -> SignalDecisionRequest:
    return SignalDecisionRequest(
        intersectionId="int_1",
        currentPhaseId=current,
        timeInPhaseMs=5000,
        phaseCandidates=[PhaseCandidate(phaseId=p, queueLength=q, waitS=w) for p, q, w in candidates],
        neighborIntersections=neighbors,
    )


def test_stays_on_current_phase_when_it_has_more_pressure():
    req = _req("NS_through", [("NS_through", 5, 10.0), ("EW_through", 1, 1.0)])
    assert decide_phase(req) == "NS_through"


def test_switches_when_other_phase_has_much_more_pressure():
    req = _req("NS_through", [("NS_through", 0, 0.0), ("EW_through", 6, 15.0)])
    assert decide_phase(req) == "EW_through"


def test_stays_when_advantage_is_below_threshold():
    req = _req("NS_through", [("NS_through", 2, 4.0), ("EW_through", 3, 4.0)])
    assert decide_phase(req) == "NS_through"


def test_absent_neighbor_intersections_behaves_identically_to_before():
    req = _req("NS_through", [("NS_through", 2, 4.0), ("EW_through", 3, 4.0)], neighbors=None)
    assert decide_phase(req) == "NS_through"


def test_switches_when_a_freshly_switched_neighbor_pushes_a_marginal_challenger_over_threshold():
    # Without a neighbor boost, EW_through's pressure (7.0) is only ~1.17x NS_through's (6.0) —
    # below MIN_ADVANTAGE_RATIO (1.5), so the base rule alone would stay on NS_through (matches
    # test_stays_when_advantage_is_below_threshold's shape).
    no_neighbor = _req("NS_through", [("NS_through", 3, 3.0), ("EW_through", 4, 3.0)])
    assert decide_phase(no_neighbor) == "NS_through"  # base case: stays (pressure 6 vs 7, below 1.5x)

    # Neighbor boost (0.5) alone isn't enough to cross 1.5x here (7.5 / 6.0 = 1.25) — this confirms
    # the boost is a real, bounded nudge, not something that always flips the decision regardless
    # of the underlying pressure gap. Use a case where the base gap is already close to threshold.
    close_case_no_neighbor = _req("NS_through", [("NS_through", 4, 0.0), ("EW_through", 6, 0.0)])
    assert decide_phase(close_case_no_neighbor) == "NS_through"  # 6 / 4 = 1.5, not strictly greater — stays

    close_case_with_neighbor = _req(
        "NS_through",
        [("NS_through", 4, 0.0), ("EW_through", 6, 0.0)],
        neighbors=[NeighborIntersection(intersectionId="int_2", currentPhaseId="EW_through", timeInPhaseMs=500, totalPressure=5.0)],
    )
    assert decide_phase(close_case_with_neighbor) == "EW_through"  # boosted to 6.5 / 4 = 1.625 > 1.5


def test_a_long_settled_neighbor_does_not_trigger_the_boost():
    req = _req(
        "NS_through",
        [("NS_through", 4, 0.0), ("EW_through", 6, 0.0)],
        neighbors=[NeighborIntersection(intersectionId="int_2", currentPhaseId="EW_through", timeInPhaseMs=10000, totalPressure=5.0)],
    )
    assert decide_phase(req) == "NS_through"  # neighbor's phase is stale (well past NEIGHBOR_FRESH_MS) — no boost
