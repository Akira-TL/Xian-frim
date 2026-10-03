#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
build_dir="${1:-${project_root}/build}"
asset_dir="${2:-${project_root}/assets/qin}"
output_dir="${build_dir}/qin-assets"
converter="${project_root}/managed_components/lvgl__lvgl/scripts/LVGLImage.py"
names=(head body legs reward)
mkdir -p "${output_dir}"
has_images=false
for name in "${names[@]}"; do
    if [[ -f "${asset_dir}/${name}.png" ]]; then has_images=true; fi
done
if [[ "${has_images}" == true ]]; then
    if [[ ! -f "${converter}" ]]; then
        echo "缺少 LVGL 图片转换工具，请先按项目说明安装固件依赖。" >&2
        exit 1
    fi
    # 转换工具是项目锁定版本的 LVGL 官方脚本；所有 Python 依赖仍由 uv 管理。
    (cd "${project_root}" && uv sync --locked --group assets)
fi
for name in "${names[@]}"; do
    if [[ -f "${asset_dir}/${name}.png" ]]; then
        (cd "${project_root}" && uv run --locked --group assets "${converter}" \
            --ofmt C --cf ARGB8888 --compress NONE \
            --name "qin_${name}" -o "${output_dir}" "${asset_dir}/${name}.png")
    else
        # 覆盖仅由本脚本生成的对应文件，防止删掉 PNG 后继续嵌入旧图片。
        printf '// 未提供 %s.png，使用页面占位图。\n' "${name}" > "${output_dir}/qin_${name}.c"
    fi
done
{
    printf '#pragma once\n#include "lvgl.h"\n'
    for name in "${names[@]}"; do
        if [[ -f "${asset_dir}/${name}.png" ]]; then
            printf 'extern const lv_image_dsc_t qin_%s;\n' "${name}"
        fi
    done
    printf 'static const lv_image_dsc_t *const qin_images[4] = {\n'
    for name in "${names[@]}"; do
        if [[ -f "${asset_dir}/${name}.png" ]]; then printf '    &qin_%s,\n' "${name}"
        else printf '    NULL,\n'; fi
    done
    printf '};\n'
} > "${output_dir}/qin_assets_generated.h"
echo "秦俑图片已准备；没有提供的图片保留占位显示。"
