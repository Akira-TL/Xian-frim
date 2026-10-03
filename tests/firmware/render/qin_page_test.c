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
static exploration_screen_t current_screen;
static exploration_game_t current_game;
static bonus_round_t rounds[2];
static uint8_t bonus_collected;
static uint8_t exhibit_game = GAME_COUNT;
esp_err_t exploration_set_screen(exploration_screen_t screen) { current_screen = screen; return ESP_OK; }
esp_err_t exploration_set_game(exploration_game_t game) { current_game = game; return ESP_OK; }
esp_err_t exploration_snapshot(exploration_snapshot_t *out)
{
    *out = (exploration_snapshot_t){.progress = progress, .puzzle = puzzle, .screen = current_screen,
        .game = current_game, .bonus_collected = bonus_collected, .exhibit_game = exhibit_game};
    memcpy(out->rounds, rounds, sizeof(rounds));
    return ESP_OK;
}
esp_err_t exploration_bonus_begin(exploration_game_t game)
{ bonus_begin(&rounds[game - 1]); return ESP_OK; }
esp_err_t exploration_bonus_answer(exploration_game_t game, uint8_t choice, bonus_result_t *result)
{
    *result = bonus_answer(game, &rounds[game - 1], choice);
    if (*result == BONUS_COMPLETED) bonus_collected |= 1u << (game - 1);
    return ESP_OK;
}
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
esp_err_t exploration_display_game(exploration_game_t game)
{
    if (game == GAME_QIN && exploration_exhibit() != ESP_OK) return ESP_FAIL;
    if (game != GAME_QIN && !(bonus_collected & (1u << (game - 1)))) return ESP_FAIL;
    exhibit_game = game;
    return ESP_OK;
}
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

static lv_point_t touch_point;
static lv_indev_state_t touch_state;
static void read_touch(lv_indev_t *input, lv_indev_data_t *data)
{ (void)input; data->point = touch_point; data->state = touch_state; }
static void touch(lv_indev_t *input, int x, int y, lv_indev_state_t state)
{
    touch_point = (lv_point_t){x, y}; touch_state = state;
    lv_tick_inc(40); lv_indev_read(input);
}
static void drag(lv_indev_t *input, int from_x, int from_y, int to_x, int to_y)
{
    touch(input, from_x, from_y, LV_INDEV_STATE_PRESSED);
    touch(input, to_x, to_y, LV_INDEV_STATE_PRESSED);
    touch(input, to_x, to_y, LV_INDEV_STATE_RELEASED);
}

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
    assert(current_screen == EXPLORATION_COVER);
    click(page.root, "开始探索");
    capture(display, "selection");
    assert(current_screen == EXPLORATION_SELECTION && begin_calls == 0);
    click(page.root, "秦俑归阵");
    capture(display, "intro");
    assert(current_screen == EXPLORATION_INTRO && begin_calls == 0);
    click(page.root, "开始游戏");
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
    assert(current_screen == EXPLORATION_SELECTION && puzzle.placed_mask == 1);
    click(page.root, "秦俑归阵");
    click(page.root, "继续游戏");
    assert(current_screen == EXPLORATION_PLAYING && begin_calls == 1 && puzzle.placed_mask == 1);
    click(page.root, "退出");
    click(page.root, "秦俑归阵");
    click(page.root, "重新开始");
    assert(begin_calls == 2 && puzzle.placed_mask == 0);
    click(page.root, "退出");
    click(page.root, "封面");
    click(page.root, "设置");
    click(page.root, "返回");
    assert(find_button(page.root, "开始探索") != NULL && begin_calls == 2);
    click(page.root, "开始探索");
    click(page.root, "秦俑归阵");
    click(page.root, "继续游戏");
    lv_obj_update_layout(page.root);
    lv_indev_t *input = lv_indev_create();
    lv_indev_set_type(input, LV_INDEV_TYPE_POINTER);
    lv_indev_set_display(input, display);
    lv_indev_set_read_cb(input, read_touch);
    lv_area_t root_bounds;
    lv_obj_get_coords(page.root, &root_bounds);
    int x = root_bounds.x1, y = root_bounds.y1;
    drag(input, x + 84, y + 190, x + 180, y + 110);
    assert(puzzle.placed_mask == 1);
    lv_obj_update_layout(page.root);
    drag(input, x + 276, y + 130, x + 180, y + 158);
    assert(puzzle.placed_mask == 3);
    lv_obj_update_layout(page.root);
    drag(input, x + 84, y + 130, x + 180, y + 206);
    assert(puzzle.placed_mask == 7 && progress.completed && progress.collected);
    assert(current_screen == EXPLORATION_RESULT);
    capture(display, "result");
    click(page.root, "查看收藏");
    assert(current_screen == EXPLORATION_COLLECTION);
    capture(display, "collection");
    click(page.root, "设为展示");
    assert(current_screen == EXPLORATION_EXHIBIT && progress.exhibiting);
    capture(display, "exhibit");
    click(page.root, "首页");
    assert(current_screen == EXPLORATION_COVER);
    click(page.root, "开始探索");
    lv_obj_update_layout(page.root);
    drag(input, x + 270, y + 140, x + 90, y + 140);
    lv_timer_handler();
    assert(current_game == GAME_GATE && current_screen == EXPLORATION_SELECTION);
    assert(find_button(page.root, "城门寻宝"));
    capture(display, "gate-selection");
    click(page.root, "城门寻宝");
    click(page.root, "开始游戏");
    capture(display, "gate-game");
    lv_obj_update_layout(page.root);
    // 先点错旗，阶段不增加，再按门、旗、鼓完成。
    drag(input, x + 110, y + 100, x + 110, y + 100);
    assert(rounds[0].stage == 0 && rounds[0].mistakes == 1);
    lv_obj_update_layout(page.root);
    drag(input, x + 180, y + 215, x + 180, y + 215);
    assert(rounds[0].stage == 1);
    click(page.root, "设置"); click(page.root, "返回");
    assert(rounds[0].stage == 1);
    click(page.root, "退出");
    lv_obj_update_layout(page.root);
    drag(input, x + 270, y + 140, x + 90, y + 140);
    lv_timer_handler();
    assert(current_game == GAME_POEM);
    click(page.root, "诗句补全"); click(page.root, "开始游戏");
    capture(display, "poem-game");
    click(page.root, "黄河入海流");
    assert(rounds[1].stage == 0);
    click(page.root, "疑是地上霜");
    assert(rounds[1].stage == 1);
    click(page.root, "黄河入海流");
    assert(current_screen == EXPLORATION_RESULT && bonus_collected == 2);
    click(page.root, "设为展示");
    assert(current_screen == EXPLORATION_EXHIBIT && exhibit_game == GAME_POEM);
    capture(display, "poem-exhibit");
    click(page.root, "首页"); click(page.root, "开始探索");
    lv_obj_update_layout(page.root);
    drag(input, x + 90, y + 140, x + 270, y + 140);
    lv_timer_handler();
    assert(current_game == GAME_GATE);
    click(page.root, "城门寻宝"); click(page.root, "继续游戏");
    assert(rounds[0].stage == 1);
    lv_obj_update_layout(page.root);
    drag(input, x + 110, y + 100, x + 110, y + 100);
    lv_obj_update_layout(page.root);
    drag(input, x + 250, y + 220, x + 250, y + 220);
    assert(current_screen == EXPLORATION_RESULT && bonus_collected == 3);
    capture(display, "gate-result");
    // 新游戏完成不能清除秦俑认证进度。
    assert(progress.completed && progress.collected && progress.exhibiting);
    lv_indev_delete(input);
    table->on_view_did_unload(&page);
    puts("通过：真实左右滑动切换三游戏，寻宝点击与诗句答题、设置和切换保留进度、独立收藏展示及秦俑拖拽");
    return 0;
}
