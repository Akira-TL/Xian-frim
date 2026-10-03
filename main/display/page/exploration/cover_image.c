#include "cover_image.h"
#include "services/cover/cover_service.h"
#include "services/cover/cover_jpeg.h"
#include <stdlib.h>

typedef struct {
    lv_image_dsc_t descriptor;
    uint16_t pixels[360 * 360];
} cover_image_t;

static void dispose(lv_event_t *event)
{
    cover_image_t *image = lv_event_get_user_data(event);
    lv_image_cache_drop(&image->descriptor);
    free(image);
}

bool cover_image_add(lv_obj_t *parent, uint32_t *revision)
{
    uint8_t *jpeg = NULL;
    size_t size = 0;
    *revision = cover_service_revision();
    if (!cover_service_copy(&jpeg, &size, revision)) return false;
    cover_image_t *image = malloc(sizeof(*image));
    bool decoded = image && cover_jpeg_decode(jpeg, size, image->pixels);
    free(jpeg);
    if (!decoded) { free(image); return false; }
    image->descriptor = (lv_image_dsc_t){
        .header = {.magic = LV_IMAGE_HEADER_MAGIC, .cf = LV_COLOR_FORMAT_RGB565,
                   .w = 360, .h = 360, .stride = 360 * 2},
        .data_size = sizeof(image->pixels), .data = (const uint8_t *)image->pixels};
    lv_obj_t *object = lv_image_create(parent);
    lv_image_set_src(object, &image->descriptor);
    lv_obj_set_pos(object, 0, 0);
    lv_obj_clear_flag(object, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_event_cb(object, dispose, LV_EVENT_DELETE, image);
    // 照片背景上仍保留清楚的标题和说明，不移动既有游戏入口。
    lv_obj_t *caption = lv_obj_create(parent);
    lv_obj_remove_style_all(caption);
    lv_obj_set_pos(caption, 55, 20);
    lv_obj_set_size(caption, 250, 92);
    lv_obj_set_style_radius(caption, 22, 0);
    lv_obj_set_style_bg_color(caption, lv_color_hex(0xfaf3e3), 0);
    lv_obj_set_style_bg_opa(caption, LV_OPA_90, 0);
    lv_obj_clear_flag(caption, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);
    return true;
}
