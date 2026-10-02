from fastapi.testclient import TestClient
import pytest

from changan.simulation import ScenarioRequest, ScenarioResult
from test_visits import client, operator, terminal

EXAMPLE = """{
  "nodes": [
    {"site_id":"A","initial_people":100,"arrivals_per_minute":10,"stay_minutes":10},
    {"site_id":"B","initial_people":0,"arrivals_per_minute":0,"stay_minutes":10},
    {"site_id":"C","initial_people":0,"arrivals_per_minute":0,"stay_minutes":10}
  ],
  "from_site":"A","to_site":"B","adoption_ratio":1,"duration_minutes":2
}"""


def test_diverted_arrivals_leave_origin_before_entering_destination(client: TestClient) -> None:
    response = client.post("/api/v1/simulation", content=EXAMPLE, headers=operator())
    assert response.status_code == 200
    result = response.json()
    assert result["source"] == "scenario_simulation"
    assert result["step_minutes"] == 1
    assert result["series"] == [
        {"minute": 0, "baseline": [{"site_id": "A", "people": 100}, {"site_id": "B", "people": 0}, {"site_id": "C", "people": 0}],
         "guided": [{"site_id": "A", "people": 100}, {"site_id": "B", "people": 0}, {"site_id": "C", "people": 0}], "diverted_arrivals": 0},
        {"minute": 1, "baseline": [{"site_id": "A", "people": 100}, {"site_id": "B", "people": 0}, {"site_id": "C", "people": 0}],
         "guided": [{"site_id": "A", "people": 90}, {"site_id": "B", "people": 10}, {"site_id": "C", "people": 0}], "diverted_arrivals": 10},
        {"minute": 2, "baseline": [{"site_id": "A", "people": 100}, {"site_id": "B", "people": 0}, {"site_id": "C", "people": 0}],
         "guided": [{"site_id": "A", "people": 81}, {"site_id": "B", "people": 19}, {"site_id": "C", "people": 0}], "diverted_arrivals": 10},
    ]


@pytest.mark.parametrize("payload", [
    EXAMPLE.replace('"site_id":"B"', '"site_id":"A"'),
    EXAMPLE.replace('"to_site":"B"', '"to_site":"A"'),
])
def test_invalid_node_sets_and_self_diversion_are_rejected(client: TestClient, payload: str) -> None:
    assert client.post("/api/v1/simulation", content=payload, headers=operator()).status_code == 422


@pytest.mark.parametrize("old,new", [
    ('"adoption_ratio":1', '"adoption_ratio":1.01'),
    ('"adoption_ratio":1', '"adoption_ratio":-0.01'),
    ('"stay_minutes":10', '"stay_minutes":0'),
    ('"duration_minutes":2', '"duration_minutes":121'),
    ('"initial_people":100', '"initial_people":-1'),
    ('"arrivals_per_minute":10', '"arrivals_per_minute":1001'),
])
def test_parameter_limits_reject_unbounded_scenarios(client: TestClient, old: str, new: str) -> None:
    assert client.post("/api/v1/simulation", content=EXAMPLE.replace(old, new), headers=operator()).status_code == 422


def test_zero_adoption_matches_no_diversion_and_never_writes_facts(client: TestClient) -> None:
    payload = EXAMPLE.replace('"adoption_ratio":1', '"adoption_ratio":0')
    response = client.post("/api/v1/simulation", content=payload, headers=operator())
    assert response.status_code == 200
    result = ScenarioResult.model_validate_json(response.text)
    assert result.parameters == ScenarioRequest.model_validate_json(payload)
    assert all(point.baseline == point.guided and point.diverted_arrivals == 0 for point in result.series)
    assert client.get("/api/v1/visits", headers=operator()).text == "[]"
    assert client.get("/api/v1/unlock-commands", headers=operator()).text == "[]"
    assert client.get("/api/v1/activity", headers=operator()).json()["progress"]["completed_badges"] == 0
    assert client.post("/api/v1/simulation", content=payload).status_code == 401
    assert client.post("/api/v1/simulation", content=payload, headers=terminal()).status_code == 401


def test_no_arrivals_cannot_move_existing_population(client: TestClient) -> None:
    payload = EXAMPLE.replace('"arrivals_per_minute":10', '"arrivals_per_minute":0')
    response = client.post("/api/v1/simulation", content=payload, headers=operator())
    assert response.status_code == 200
    result = ScenarioResult.model_validate_json(response.text)
    assert [point.guided[0].people for point in result.series] == [100, 90, 81]
    assert all(point.diverted_arrivals == 0 and point.guided[1].people == 0 for point in result.series)


def test_one_minute_stay_never_produces_negative_population(client: TestClient) -> None:
    payload = EXAMPLE.replace('"stay_minutes":10', '"stay_minutes":1')
    response = client.post("/api/v1/simulation", content=payload, headers=operator())
    assert response.status_code == 200
    result = ScenarioResult.model_validate_json(response.text)
    assert [point.guided[0].people for point in result.series] == [100, 0, 0]
    assert [point.guided[1].people for point in result.series] == [0, 10, 10]


def test_numeric_overflow_is_a_validation_error_not_a_server_failure(client: TestClient) -> None:
    payload = EXAMPLE.replace('"arrivals_per_minute":10', '"arrivals_per_minute":1e309')
    response = client.post("/api/v1/simulation", content=payload, headers=operator())
    assert response.status_code == 422
