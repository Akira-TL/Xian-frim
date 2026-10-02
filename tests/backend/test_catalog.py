from fastapi.testclient import TestClient

from test_visits import client, operator, terminal


def test_demo_catalog_matches_prd_and_does_not_claim_extra_games(client: TestClient) -> None:
    response = client.get("/api/v1/sites", headers=operator())
    assert response.status_code == 200
    catalog = response.json()
    assert catalog["source"] == "demo_site_configuration"
    assert catalog["geographic_map"] is False
    assert [(site["site_id"], site["name"], site["game_available"]) for site in catalog["sites"]] == [
        ("A", "秦俑工坊", True), ("B", "长安城门", False), ("C", "诗意庭院", False),
    ]
    assert client.get("/api/v1/sites", headers=terminal()).status_code == 200
    assert client.get("/api/v1/sites").status_code == 401
