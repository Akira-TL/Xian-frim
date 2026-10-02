from pathlib import Path
import stat

import pytest

from changan.device_protocol import DeviceKeys
from changan.provision import provision


DEVICE = "esp32s3-001122334455"


def test_private_configuration_and_repeat_keep_same_key(tmp_path: Path) -> None:
    path = provision(DEVICE, tmp_path / "data")
    content = path.read_bytes()
    keys = DeviceKeys.model_validate_json(content)
    assert keys.devices[0].device_id == DEVICE
    assert len(keys.devices[0].bytes()) == 32
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    header = path.parent / "generated/changan_device_key.h"
    generated = header.read_bytes()
    assert stat.S_IMODE(header.stat().st_mode) == 0o600
    assert b"CHANGAN_DEVICE_KEY_CONFIGURED 1" in generated
    assert b"0x00, 0x11, 0x22, 0x33, 0x44, 0x55" in generated
    expected = ", ".join(f"0x{byte:02x}" for byte in keys.devices[0].bytes()).encode()
    assert expected in generated
    provision(DEVICE, path.parent)
    assert path.read_bytes() == content
    assert header.read_bytes() == generated


def test_wrong_device_and_invalid_identity_do_not_replace_configuration(tmp_path: Path) -> None:
    path = provision(DEVICE, tmp_path)
    content = path.read_bytes()
    with pytest.raises(ValueError):
        provision("esp32s3-ffeeddccbbaa", tmp_path)
    with pytest.raises(ValueError):
        provision("not-a-device", tmp_path)
    assert path.read_bytes() == content


def test_rejects_loose_permissions_or_symlink(tmp_path: Path) -> None:
    path = provision(DEVICE, tmp_path)
    content = path.read_bytes()
    path.chmod(0o644)
    with pytest.raises(ValueError):
        provision(DEVICE, tmp_path)
    assert path.read_bytes() == content
    linked = tmp_path / "linked"
    linked.symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ValueError):
        provision(DEVICE, linked)
    path.chmod(0o600)
    target = tmp_path / "original.json"
    path.rename(target)
    path.symlink_to(target)
    with pytest.raises(OSError):
        provision(DEVICE, tmp_path)
    assert target.read_bytes() == content
