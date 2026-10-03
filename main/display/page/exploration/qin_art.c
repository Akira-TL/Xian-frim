#include "qin_art.h"
#include "src/draw/lv_image_decoder_private.h"
#include <string.h>

#if __has_include("qin_assets_generated.h")
#include "qin_assets_generated.h"
#else
static const lv_image_dsc_t *const qin_images[QIN_ART_COUNT] = {NULL};
#endif

static bool usable(const lv_image_dsc_t *source)
{
    // 当前素材管线只产出有界的 ARGB8888 图，先检查长度再交给解码器。
    if (!source || !source->data || source->header.magic != LV_IMAGE_HEADER_MAGIC ||
        !source->header.w || !source->header.h || source->header.w > 360 ||
        source->header.h > 360 || source->header.cf != LV_COLOR_FORMAT_ARGB8888 ||
        source->header.stride != source->header.w * 4) return false;
    if (source->header.flags & LV_IMAGE_FLAGS_COMPRESSED) {
        if (source->data_size < 12) return false;
        uint32_t sizes[3];
        memcpy(sizes, source->data, sizeof(sizes));
        if (sizes[1] != source->data_size - 12 ||
            sizes[2] != source->header.stride * source->header.h) return false;
    } else if (source->data_size != source->header.stride * source->header.h) return false;
    lv_image_decoder_dsc_t decoder = {0};
    lv_image_decoder_args_t args = {.no_cache = true};
    if (lv_image_decoder_open(&decoder, source, &args) != LV_RESULT_OK) return false;
    bool complete = decoder.decoded != NULL;
    lv_image_decoder_close(&decoder);
    return complete;
}

static void placeholder(lv_obj_t *parent, int width, int height)
{
    // 通用纪念章由原生图形构成，不再依赖另一张可能同样损坏的图片。
    int size = width < height ? width : height;
    if (size > 112) size = 112;
    lv_obj_t *badge = lv_obj_create(parent);
    lv_obj_remove_style_all(badge);
    lv_obj_set_size(badge, size, size);
    lv_obj_center(badge);
    lv_obj_set_style_radius(badge, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(badge, lv_color_hex(0xf1e5cd), 0);
    lv_obj_set_style_bg_opa(badge, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(badge, lv_color_hex(0xb99861), 0);
    lv_obj_set_style_border_width(badge, 3, 0);
    lv_obj_clear_flag(badge, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_t *star = lv_label_create(badge);
    lv_label_set_text(star, LV_SYMBOL_IMAGE);
    lv_obj_set_style_text_font(star, LV_FONT_DEFAULT, 0);
    lv_obj_set_style_text_color(star, lv_color_hex(0x973e2d), 0);
    lv_obj_center(star);
    lv_obj_clear_flag(star, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);
}

bool qin_art_add(lv_obj_t *parent, qin_art_id_t id, int width, int height)
{
    if (id < 0 || id >= QIN_ART_COUNT || width <= 0 || height <= 0) return false;
    const lv_image_dsc_t *source = qin_images[id];
    // 编译进固件的只读素材只需成功验证一次；分配失败不永久记为坏图。
    static bool validated[QIN_ART_COUNT];
    if (!validated[id] && !usable(source)) {
        if (id >= QIN_ART_REWARD) placeholder(parent, width, height);
        return false;
    }
    validated[id] = true;
    uint32_t scale_x = (uint32_t)width * 256 / source->header.w;
    uint32_t scale_y = (uint32_t)height * 256 / source->header.h;
    uint32_t scale = scale_x < scale_y ? scale_x : scale_y;
    if (!scale) return false;
    lv_obj_t *image = lv_image_create(parent);
    lv_image_set_src(image, source);
    lv_image_set_scale(image, scale);
    lv_obj_center(image);
    lv_obj_clear_flag(image, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);
    return true;
}
