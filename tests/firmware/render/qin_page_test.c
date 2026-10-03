#include "cl_ui.h"
#include "services/exploration/exploration.h"
#include "ui_tool.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

extern page_vtable_t *exploration_create(const char *name);
static qin_progress_t progress = {.unlocked = true};
static qin_puzzle_t puzzle;
static unsigned begin_calls, brightness_writes, volume_writes;
static uint8_t brightness = 50;
static int volume = 50;
static uint8_t framebuffer[360 * 360 * 2];

// 边界替身：不访问串口、NVS、真实扬声器或用户进度。
esp_err_t exploration_get(qin_progress_t *out_progress, qin_puzzle_t *out_puzzle, char *session)
{
    if (out_progress) *out_progress = progress;
    if (out_puzzle) *out_puzzle = puzzle;
    if (session) strcpy(session, "demo-001");
    return ESP_OK;
}
esp_err_t exploration_begin(void) { ++begin_calls; qin_puzzle_begin(&puzzle); return ESP_OK; }
esp_err_t exploration_select(uint8_t piece, qin_result_t *result)
{ *result = qin_select(&progress, &puzzle, piece); return ESP_OK; }
esp_err_t exploration_place(uint8_t slot, qin_result_t *result)
{ *result = qin_place(&progress, &puzzle, slot); return ESP_OK; }
esp_err_t exploration_exhibit(void) { return qin_exhibit(&progress) ? ESP_OK : ESP_FAIL; }
uint8_t ui_tool_get_brightness(void) { return brightness; }
int ui_tool_get_volume(void) { return volume; }
void ui_tool_set_brightness(uint8_t value) { brightness = value; ++brightness_writes; }
void ui_tool_set_volume(int value) { volume = value; ++volume_writes; }
void ui_tool_play_game_sound(void) {}
void page_set_custom_cache_enable(page_base_t *self, bool enabled) { (void)self; (void)enabled; }
void page_set_custom_load_anim_type(page_base_t *self, uint8_t type, uint16_t time, lv_anim_path_cb_t path)
{ (void)self; (void)type; (void)time; (void)path; }

static lv_obj_t *find_button(lv_obj_t *root, const char *text)
{
    for (uint32_t i = 0; i < lv_obj_get_child_count(root); ++i) {
        lv_obj_t *object = lv_obj_get_child(root, i);
        if (!lv_obj_check_type(object, &lv_button_class)) continue;
        for (uint32_t j = 0; j < lv_obj_get_child_count(object); ++j) {
            lv_obj_t *child = lv_obj_get_child(object, j);
            if (lv_obj_check_type(child, &lv_label_class) && strcmp(lv_label_get_text(child), text) == 0)
                return object;
        }
    }
    return NULL;
}
static void click(lv_obj_t *root, const char *text)
{
    lv_obj_t *object = find_button(root, text);
    assert(object != NULL);
    lv_obj_send_event(object, LV_EVENT_CLICKED, NULL);
}
static void flush(lv_display_t *display, const lv_area_t *area, uint8_t *pixels)
{ (void)area; (void)pixels; lv_display_flush_ready(display); }

// 可选导出正式页面的实际绘制缓冲；不是实物屏幕摄影。
static void capture(lv_display_t *display, const char *name)
{
    const char *directory = getenv("QIN_PREVIEW_DIR");
    if (!directory) return;
    lv_refr_now(display);
    char path[1024];
    assert(snprintf(path, sizeof(path), "%s/%s.ppm", directory, name) < (int)sizeof(path));
    FILE *file = fopen(path, "wb");
    assert(file);
    fprintf(file, "P6\n360 360\n255\n");
    for (unsigned i = 0; i < 360 * 360; ++i) {
        uint16_t pixel;
        memcpy(&pixel, framebuffer + i * 2, 2);
        unsigned char rgb[] = {(pixel >> 11) * 255 / 31,
            ((pixel >> 5) & 63) * 255 / 63, (pixel & 31) * 255 / 31};
        assert(fwrite(rgb, 1, 3, file) == 3);
    }
    assert(fclose(file) == 0);
}

int main(void)
{
    lv_init();
    lv_display_t *display = lv_display_create(360, 360);
    lv_display_set_color_format(display, LV_COLOR_FORMAT_RGB565);
    lv_display_set_buffers(display, framebuffer, NULL, sizeof(framebuffer), LV_DISPLAY_RENDER_MODE_DIRECT);
    lv_display_set_flush_cb(display, flush);
    page_base_t page = {.root = lv_obj_create(lv_screen_active())};
    page_vtable_t *table = exploration_create("exploration");
    table->on_view_load(&page);
    capture(display, "home");
    click(page.root, "开始秦俑归阵");
    capture(display, "game");
    assert(begin_calls == 1);
    qin_result_t result;
    exploration_select(0, &result);
    exploration_place(0, &result);  // 设置测试起点：设备状态已有一片，不冒充触摸拖放。
    assert(puzzle.placed_mask == 1);
    qin_puzzle_t before = puzzle;
    click(page.root, "设置");
    capture(display, "settings");
    lv_obj_t *sliders[2] = {NULL, NULL};
    unsigned count = 0;
    for (uint32_t i = 0; i < lv_obj_get_child_count(page.root); ++i) {
        lv_obj_t *object = lv_obj_get_child(page.root, i);
        if (lv_obj_check_type(object, &lv_slider_class)) {
            assert(count < 2);
            sliders[count++] = object;
        }
    }
    assert(count == 2);
    assert(lv_slider_get_min_value(sliders[0]) == 10 && lv_slider_get_max_value(sliders[0]) == 100);
    assert(lv_slider_get_min_value(sliders[1]) == 0 && lv_slider_get_max_value(sliders[1]) == 100);
    lv_slider_set_value(sliders[0], 17, LV_ANIM_OFF);
    lv_slider_set_value(sliders[1], 0, LV_ANIM_OFF);
    lv_obj_send_event(sliders[0], LV_EVENT_VALUE_CHANGED, NULL);
    lv_obj_send_event(sliders[1], LV_EVENT_VALUE_CHANGED, NULL);
    assert(brightness_writes == 0 && volume_writes == 0);
    lv_obj_send_event(sliders[0], LV_EVENT_RELEASED, NULL);
    lv_obj_send_event(sliders[1], LV_EVENT_RELEASED, NULL);
    assert(brightness == 17 && volume == 0 && brightness_writes == 1 && volume_writes == 1);
    click(page.root, "返回");
    assert(begin_calls == 1 && puzzle.placed_mask == before.placed_mask
        && puzzle.selected_piece == before.selected_piece && puzzle.mistakes == before.mistakes);
    lv_obj_update_layout(page.root);
    bool visible_placed_slot = false;
    for (uint32_t i = 0; i < lv_obj_get_child_count(page.root); ++i) {
        lv_obj_t *object = lv_obj_get_child(page.root, i);
        if (lv_obj_get_x(object) == 144 && lv_obj_get_y(object) == 88) {
            visible_placed_slot = lv_obj_get_style_border_width(object, 0) == 4
                && lv_color_eq(lv_obj_get_style_border_color(object, 0), lv_color_hex(0xffdc75))
                && lv_obj_get_child_count(object) > 0;
        }
    }
    assert(visible_placed_slot && find_button(page.root, "退出") != NULL);
    lv_refr_now(display);  // 正式字体、页面及素材实际进入绘制。
    click(page.root, "退出");
    click(page.root, "设置");
    click(page.root, "返回");
    assert(find_button(page.root, "开始秦俑归阵") != NULL && begin_calls == 1);
    table->on_view_did_unload(&page);
    puts("通过：正式游戏页面设置返回保留碎片和亮边，首页返回正确，滑块仅松手保存；不替代实物触摸或NVS验收");
    return 0;
}
