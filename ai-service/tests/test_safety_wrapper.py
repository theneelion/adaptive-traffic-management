from app.safety_wrapper import apply_safety_constraints, PhaseDecision, IntersectionState, SafetyRules


def test_vetoes_switch_before_min_green_elapsed():
    proposed = PhaseDecision(phase_id="EW_through", controller="rule_based")
    state = IntersectionState(current_phase_id="NS_through", time_in_phase_ms=1000, all_phase_ids=["NS_through", "EW_through"])
    result = apply_safety_constraints(proposed, state, SafetyRules(min_green_ms=4000, max_green_ms=20000))
    assert result.phase_id == "NS_through"


def test_allows_switch_after_min_green_elapsed():
    proposed = PhaseDecision(phase_id="EW_through", controller="rule_based")
    state = IntersectionState(current_phase_id="NS_through", time_in_phase_ms=5000, all_phase_ids=["NS_through", "EW_through"])
    result = apply_safety_constraints(proposed, state, SafetyRules(min_green_ms=4000, max_green_ms=20000))
    assert result.phase_id == "EW_through"


def test_forces_switch_after_max_green_even_if_proposal_says_stay():
    proposed = PhaseDecision(phase_id="NS_through", controller="rule_based")
    state = IntersectionState(current_phase_id="NS_through", time_in_phase_ms=21000, all_phase_ids=["NS_through", "EW_through"])
    result = apply_safety_constraints(proposed, state, SafetyRules(min_green_ms=4000, max_green_ms=20000))
    assert result.phase_id == "EW_through"
