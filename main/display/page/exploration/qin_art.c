#include "qin_art.h"

#if __has_include("qin_assets_generated.h")
#include "qin_assets_generated.h"
#else
static const lv_image_dsc_t *const qin_images[QIN_ART_COUNT] = {NULL};
#endif

bool qin_art_add(lv_obj_t *parent, qin_art_id_t id, int width, int height)
{
    if (id < 0 || id >= QIN_ART_COUNT || width <= 0 || height <= 0) return false;
    const lv_image_dsc_t *source = qin_images[id];
    if (!source || !source->header.w || !source->header.h) return false;
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
