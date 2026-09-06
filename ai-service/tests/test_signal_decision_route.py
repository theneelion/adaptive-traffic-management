from fastapi.testclient import TestClient
import app.routes as routes_module
from app.main import app

client = TestClient(app)


def test_signal_decision_returns_rule_based_controller():
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
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["phaseId"] == "EW_through"
    assert body["controller"] == "rule_based"


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


def test_signal_decision_uses_rl_policy_when_requested_and_a_promoted_model_is_loaded(monkeypatch):
    # Regression test for a real bug found during implementation: req.requestedController is a
    # plain (non-str-mixin) pydantic Enum, so a naive `== "rl"` string comparison is always False
    # and the RL branch would silently never activate no matter what a client requests. This test
    # injects a fake policy directly (bypassing the module-level "does models/promoted.onnx exist
    # on disk" check) so the routing logic itself — the part that was actually buggy — is exercised
    # without needing a real trained checkpoint on disk.
    class _FakePolicy:
        def decide(self, obs):
            return 1  # always propose EW_through (index 1 in PHASE_IDS)

    monkeypatch.setattr(routes_module, "_rl_policy", _FakePolicy())

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
            "approachStates": [
                {"approachId": "app_N", "direction": "N", "queueLength": 0, "waitS": 0.0},
                {"approachId": "app_S", "direction": "S", "queueLength": 0, "waitS": 0.0},
                {"approachId": "app_E", "direction": "E", "queueLength": 6, "waitS": 15.0},
                {"approachId": "app_W", "direction": "W", "queueLength": 6, "waitS": 15.0},
            ],
            "pedestrianCrossings": [
                {"crossingId": "cross_N", "queueLength": 0, "waitS": 0.0},
                {"crossingId": "cross_S", "queueLength": 0, "waitS": 0.0},
                {"crossingId": "cross_E", "queueLength": 0, "waitS": 0.0},
                {"crossingId": "cross_W", "queueLength": 0, "waitS": 0.0},
            ],
            "requestedController": "rl",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["controller"] == "rl"
    assert body["phaseId"] == "EW_through"


def test_ev_context_overrides_both_rule_based_and_safety_wrapper():
    response = client.post(
        "/signal-decision",
        json={
            "intersectionId": "int_1",
            "currentPhaseId": "NS_through",
            "timeInPhaseMs": 5000,
            "phaseCandidates": [
                {"phaseId": "NS_through", "queueLength": 5, "waitS": 10.0},
                {"phaseId": "EW_through", "queueLength": 0, "waitS": 0.0},
            ],
            "approachStates": [],
            "pedestrianCrossings": [],
            "evContext": {"evId": "amb_1", "etaS": 4.0, "requiredPhaseId": "EW_through"},
        },
    )
    assert response.status_code == 200
    # NS_through clearly has more queue pressure (rule_based would keep it), but the EV needs EW_through.
    assert response.json()["phaseId"] == "EW_through"
