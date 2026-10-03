#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_name="${1:-changan-youji-20261003-games-v5}"
[[ "${package_name}" =~ ^changan-youji-[0-9]{8}-[a-z0-9-]+$ ]] || { echo "包名无效" >&2; exit 2; }
cd "${project_root}"
jq -e '.flash_files == {"0x0":"bootloader/bootloader.bin", "0x8000":"partition_table/partition-table.bin", "0xd000":"ota_data_initial.bin", "0x10000":"srmodels/srmodels.bin", "0x100000":"xiaozhi.bin"}' build/flasher_args.json >/dev/null
package_dir="${project_root}/releases/${package_name}"
[[ ! -e "${package_dir}" && ! -e "${package_dir}.tar.gz" ]] || { echo "已有同名包，拒绝覆盖" >&2; exit 1; }
mkdir -p "${package_dir}/bootloader" "${package_dir}/partition_table" "${package_dir}/srmodels"
files=(bootloader/bootloader.bin partition_table/partition-table.bin ota_data_initial.bin srmodels/srmodels.bin xiaozhi.bin flash_args flasher_args.json)
for file in "${files[@]}"; do cp "build/${file}" "${package_dir}/${file}"; done
cp docs/deployment/远程固件烧录说明.md "${package_dir}/烧录说明.md"
(cd "${package_dir}" && sha256sum "${files[@]}" > SHA256SUMS.txt && sha256sum -c SHA256SUMS.txt)
cmp build/xiaozhi.bin "${package_dir}/xiaozhi.bin"
tar -czf "${package_dir}.tar.gz" -C "${project_root}/releases" "${package_name}"
du -h "${package_dir}.tar.gz"
