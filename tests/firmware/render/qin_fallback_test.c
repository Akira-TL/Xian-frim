#include "qin_art.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static uint8_t pixels[240 * 200 * 2];
static uint8_t baseline[sizeof(pixels)];
static void flush(lv_display_t *display, const lv_area_t *area, uint8_t *data)
{
    (void)area;
    (void)data;
    lv_display_flush_ready(display);
}

int main(void)
{
    lv_init();
    lv_display_t *display = lv_display_create(240, 200);
    lv_display_set_color_format(display, LV_COLOR_FORMAT_RGB565);
    lv_display_set_buffers(display, pixels, NULL, sizeof(pixels), LV_DISPLAY_RENDER_MODE_DIRECT);
    lv_display_set_flush_cb(display, flush);
    for (int id = 0; id < QIN_ART_COUNT; ++id) {
        lv_obj_t *screen = lv_screen_active();
        lv_obj_clean(screen);
        lv_obj_t *card = lv_obj_create(screen);
        lv_obj_set_size(card, 160, 160);
        lv_obj_center(card);
        lv_refr_now(display);
        memcpy(baseline, pixels, sizeof(pixels));
        assert(!qin_art_add(card, (qin_art_id_t)id, 128, 128));
        lv_refr_now(display);
        size_t changed = 0;
        for (size_t i = 0; i < sizeof(pixels); i += 2)
            if (pixels[i] != baseline[i] || pixels[i + 1] != baseline[i + 1]) ++changed;
        if (id < QIN_ART_REWARD) {
            assert(lv_obj_get_child_count(card) == 0);
        } else {
            assert(changed > 100);
            assert(lv_obj_get_child_count(card) == 1);
            assert(!lv_obj_has_flag(lv_obj_get_child(card, 0), LV_OBJ_FLAG_CLICKABLE));
        }
        printf("损坏素材%d：通用图改变%zu像素；%s\n", id, changed,
               id < QIN_ART_REWARD ? "交由碎片轮廓降级" : "通用章可见");
    }
    assert(!qin_art_add(lv_screen_active(), QIN_ART_COUNT, 128, 128));
    puts("通过：缺失、不兼容、短数据、坏压缩及零尺寸素材不会生成空奖励卡片");
    return 0;
}
