from app.ev_override import apply_ev_override, EvContext
from app.safety_wrapper import PhaseDecision


def test_no_override_when_ev_context_is_none():
    decision = PhaseDecision(phase_id="NS_through", controller="rule_based")
    result = apply_ev_override(decision, None)
    assert result.phase_id == "NS_through"


def test_no_override_when_eta_outside_preempt_window():
    decision = PhaseDecision(phase_id="NS_through", controller="rule_based")
    ev_context = EvContext(ev_id="amb_1", eta_s=30.0, required_phase_id="EW_through")
    result = apply_ev_override(decision, ev_context)
    assert result.phase_id == "NS_through"


def test_overrides_to_required_phase_within_preempt_window():
    decision = PhaseDecision(phase_id="NS_through", controller="rule_based")
    ev_context = EvContext(ev_id="amb_1", eta_s=8.0, required_phase_id="EW_through")
    result = apply_ev_override(decision, ev_context)
    assert result.phase_id == "EW_through"


def test_leaves_proposal_unchanged_when_it_already_matches_the_required_phase():
    decision = PhaseDecision(phase_id="EW_through", controller="rule_based")
    ev_context = EvContext(ev_id="amb_1", eta_s=3.0, required_phase_id="EW_through")
    result = apply_ev_override(decision, ev_context)
    assert result.phase_id == "EW_through"
