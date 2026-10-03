#include "qin_art.h"
#include <stdio.h>
#include <string.h>

enum { WIDTH = 240, HEIGHT = 200 };
static uint8_t framebuffer[WIDTH * HEIGHT * 2];
static uint8_t baseline[sizeof(framebuffer)];

static void flush(lv_display_t *display, const lv_area_t *area, uint8_t *pixels)
{
    (void)area;
    (void)pixels;
    lv_display_flush_ready(display);
}

static bool renders_visible_image(lv_display_t *display, qin_art_id_t id,
                                  const char *name, int width, int height)
{
    lv_obj_t *screen = lv_screen_active();
    lv_obj_clean(screen);
    lv_obj_set_style_bg_color(screen, lv_color_hex(0x211c18), 0);
    lv_obj_t *card = lv_button_create(screen);
    lv_obj_set_size(card, width, id == QIN_ART_REWARD ? height : 54);
    lv_obj_center(card);
    lv_obj_set_style_bg_color(card, lv_color_hex(0x694631), 0);
    lv_obj_set_style_pad_all(card, 0, 0);
    lv_refr_now(display);
    memcpy(baseline, framebuffer, sizeof(framebuffer));

    if(!qin_art_add(card, id, width, height)) {
        fprintf(stderr, "失败：%s素材无法添加\n", name);
        return false;
    }
    lv_refr_now(display);
    size_t changed = 0;
    for(size_t i = 0; i < sizeof(framebuffer); i += 2) {
        if(framebuffer[i] != baseline[i] || framebuffer[i + 1] != baseline[i + 1]) changed++;
    }
    printf("%s图片绘制改变像素数：%zu\n", name, changed);
    // 已提供非空人物图片，必须相对空卡片产生明显可见像素。
    if(changed < 100) {
        fprintf(stderr, "失败：%s图片未绘制，仍为空卡片\n", name);
        return false;
    }
    return true;
}

int main(void)
{
    lv_init();
    lv_display_t *display = lv_display_create(WIDTH, HEIGHT);
    lv_display_set_color_format(display, LV_COLOR_FORMAT_RGB565);
    lv_display_set_buffers(display, framebuffer, NULL, sizeof(framebuffer), LV_DISPLAY_RENDER_MODE_DIRECT);
    lv_display_set_flush_cb(display, flush);
    bool passed = true;
    passed &= renders_visible_image(display, QIN_ART_HEAD, "头部", 72, 46);
    passed &= renders_visible_image(display, QIN_ART_BODY, "身体", 72, 46);
    passed &= renders_visible_image(display, QIN_ART_LEGS, "腿部", 72, 46);
    passed &= renders_visible_image(display, QIN_ART_REWARD, "收藏奖励", 200, 160);
    if(!passed) return 1;
    puts("通过：四张正式素材均经真实绘制入口产生可见像素；不替代实物显示和触摸验收");
    return 0;
}
