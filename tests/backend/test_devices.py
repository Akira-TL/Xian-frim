from datetime import timedelta
from pathlib import Path
import hashlib
import hmac

from fastapi.testclient import TestClient
import pytest

from changan.api import create_app
from changan.device_protocol import DeviceEnvelope, DeviceKey, DeviceReport, DeviceState, NonceRequest
from changan.models import UnlockCommand, UnlockRequest
from test_visits import NOW, operator, post_scan, register, scan, terminal

DEVICE = "esp32s3-001122334455"
KEY = bytes(range(32))  # 仅测试夹具，不是实际设备密钥。


@pytest.fixture
def device_client(tmp_path: Path) -> TestClient:
    client = TestClient(create_app(tmp_path / "device.sqlite3", "operator-test", "terminal-test",
                                  lambda: NOW, (DeviceKey(device_id=DEVICE, key=KEY.hex()),)))
    register(client, device_id=DEVICE)
    post_scan(client, scan())
    request = UnlockRequest(command_id="unlock-001", event_id="scan-001", badge_id="badge-001", device_id=DEVICE)
    assert client.post("/api/v1/unlock-commands", content=request.model_dump_json(), headers=operator()).status_code == 200
    return client


def authorize(client: TestClient) -> DeviceEnvelope:
    response = client.post("/api/v1/badges/badge-001/unlock-commands/unlock-001/authorize",
                           content=NonceRequest(nonce="11" * 16).model_dump_json(), headers=operator())
    assert response.status_code == 200, response.text
    return DeviceEnvelope.model_validate_json(response.text)


def query(client: TestClient) -> DeviceEnvelope:
    response = client.post("/api/v1/badges/badge-001/state-challenges", headers=operator())
    assert response.status_code == 200
    return DeviceEnvelope.model_validate_json(response.text)


def report(envelope: DeviceEnvelope, flags: int, command: str = "unlock-001",
           mac: bytes = bytes.fromhex("001122334455")) -> DeviceReport:
    # 独立设备夹具按文档封装，不调用后台生成器或校验器。
    body = b"CS\x01" + mac + bytes.fromhex(envelope.challenge) + bytes([flags]) + command.encode().ljust(64, b"\0")
    packet = body + hmac.new(KEY, body, hashlib.sha256).digest()
    return DeviceReport(challenge=envelope.challenge, payload_hex=packet.hex())


def submit(client: TestClient, request: DeviceReport):
    return client.post("/api/v1/device-reports", content=request.model_dump_json(), headers=operator())


def test_authorization_is_signed_but_not_execution_confirmation(device_client: TestClient) -> None:
    envelope = authorize(device_client)
    packet = bytes.fromhex(envelope.payload_hex)
    assert len(packet) == 137
    assert packet[:9] == b"CU\x01\x00\x11\x22\x33\x44\x55"
    assert packet[9:25] == b"\x11" * 16
    assert packet[25:89] == b"unlock-001" + b"\0" * 54
    assert packet[89:105] == bytes.fromhex(envelope.challenge)
    assert hmac.compare_digest(packet[105:], hmac.new(KEY, packet[:105], hashlib.sha256).digest())
    assert device_client.get("/api/v1/badges/badge-001/progress", headers=operator()).status_code == 404
    request = UnlockRequest(command_id="retry", event_id="scan-001", badge_id="badge-001", device_id=DEVICE)
    result = device_client.post("/api/v1/unlock-commands", content=request.model_dump_json(), headers=operator())
    assert UnlockCommand.model_validate_json(result.text).status == "pending"


def test_forged_or_wrong_identity_receipts_cannot_confirm(device_client: TestClient) -> None:
    envelope = authorize(device_client)
    original = report(envelope, 1)
    changed = f"{int(original.payload_hex[-2:], 16) ^ 1:02x}"
    forged = original.model_copy(update={"payload_hex": original.payload_hex[:-2] + changed})
    assert submit(device_client, forged).status_code == 409
    assert submit(device_client, report(envelope, 1, mac=bytes.fromhex("aabbccddeeff"))).status_code == 409
    assert submit(device_client, report(envelope, 1, command="other-command")).status_code == 409
    assert submit(device_client, report(envelope, 0)).status_code == 409
    assert submit(device_client, report(envelope, 3)).status_code == 409
    assert device_client.get("/api/v1/badges/badge-001/progress", headers=operator()).status_code == 404


def test_verified_completion_survives_old_response_and_retries(device_client: TestClient) -> None:
    unlock = authorize(device_client)
    old = query(device_client)
    result = submit(device_client, report(unlock, 15))
    assert result.status_code == 200
    assert DeviceState.model_validate_json(result.text).collected
    result = submit(device_client, report(old, 0, command=""))
    assert DeviceState.model_validate_json(result.text).completed
    assert DeviceState.model_validate_json(submit(device_client, report(unlock, 15)).text).exhibiting
    assert submit(device_client, report(unlock, 1)).status_code == 409
    request = UnlockRequest(command_id="retry", event_id="scan-001", badge_id="badge-001", device_id=DEVICE)
    result = device_client.post("/api/v1/unlock-commands", content=request.model_dump_json(), headers=operator())
    assert UnlockCommand.model_validate_json(result.text).status == "confirmed"


def test_unconfigured_keys_and_terminal_permissions_fail_closed(tmp_path: Path) -> None:
    client = TestClient(create_app(tmp_path / "no-key.sqlite3", "operator-test", "terminal-test", lambda: NOW))
    register(client, device_id=DEVICE)
    assert client.post("/api/v1/badges/badge-001/state-challenges", headers=operator()).status_code == 503
    assert client.post("/api/v1/badges/badge-001/state-challenges", headers=terminal()).status_code == 401


def test_expired_challenge_cannot_create_progress(tmp_path: Path) -> None:
    path = tmp_path / "expires.sqlite3"
    keys = (DeviceKey(device_id=DEVICE, key=KEY.hex()),)
    first = TestClient(create_app(path, "operator-test", "terminal-test", lambda: NOW, keys))
    register(first, device_id=DEVICE)
    envelope = query(first)
    later = TestClient(create_app(path, "operator-test", "terminal-test", lambda: NOW + timedelta(seconds=31), keys))
    assert submit(later, report(envelope, 7, command="")).status_code == 409
    assert later.get("/api/v1/badges/badge-001/progress", headers=operator()).status_code == 404


def test_authenticated_progress_survives_backend_restart(device_client: TestClient, tmp_path: Path) -> None:
    envelope = authorize(device_client)
    receipt = report(envelope, 15)
    assert submit(device_client, receipt).status_code == 200
    restarted = TestClient(create_app(tmp_path / "device.sqlite3", "operator-test", "terminal-test",
                                     lambda: NOW + timedelta(minutes=2), (DeviceKey(device_id=DEVICE, key=KEY.hex()),)))
    response = restarted.get("/api/v1/badges/badge-001/progress", headers=operator())
    progress = DeviceState.model_validate_json(response.text)
    assert progress.completed and progress.collected and progress.exhibiting
    # 已消费回执可以幂等重试，但不能假装产生新的认证时间。
    repeated = DeviceState.model_validate_json(submit(restarted, receipt).text)
    assert repeated.verified_at == NOW
