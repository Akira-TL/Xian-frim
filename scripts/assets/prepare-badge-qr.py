# /// script
# requires-python = ">=3.12"
# dependencies = ["segno==1.6.6", "Pillow==11.3.0", "zxing-cpp==2.3.0"]
# ///
"""生成不带凭据的标准二维码；独立解码后才交付。"""

import argparse
from hashlib import sha256
from pathlib import Path
import re
from tempfile import TemporaryDirectory

from PIL import Image
import segno
import zxingcpp


def validate_payload(payload: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_-]{1,47}", payload) is None:
        raise ValueError("腰牌标识只能是1—47位ASCII字母、数字、下划线或连字符")
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--badge-id", default="badge-001")
    args = parser.parse_args()
    payload = validate_payload(args.badge_id)
    destination = Path(__file__).resolve().parents[2] / "assets" / "qr"
    code = segno.make_qr(payload, error="H", mode="byte", encoding="ascii")
    with TemporaryDirectory(prefix="changan-qr-") as temporary:
        prepared: list[tuple[Path, Path]] = []
        for extension in ("png", "svg"):
            source = Path(temporary) / f"{payload}.{extension}"
            code.save(source, scale=10, border=4, dark="black", light="white")
            target = destination / source.name
            if target.is_symlink() or (target.exists() and target.read_bytes() != source.read_bytes()):
                raise FileExistsError(f"不覆盖已有不同资源：{target}")
            prepared.append((source, target))
        with Image.open(prepared[0][0]) as image:
            decoded = zxingcpp.read_barcodes(image)
            if len(decoded) != 1 or decoded[0].text != payload or decoded[0].format != zxingcpp.BarcodeFormat.QRCode:
                raise ValueError("独立解码结果不匹配，拒绝交付二维码")
            print(f"独立解码通过：{payload}；{image.width}×{image.height}像素，四模块白边")
        destination.mkdir(parents=True, exist_ok=True)
        for source, target in prepared:
            if not target.exists():
                target.write_bytes(source.read_bytes())
            print(f"{sha256(target.read_bytes()).hexdigest()}  {target.relative_to(destination.parent.parent)}")


if __name__ == "__main__":
    main()
