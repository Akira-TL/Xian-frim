#include "lvgl.h"
#include "cl_ui.h"
#include "services/exploration/exploration.h"
#include "qin_art.h"
#include "cover_image.h"
#include "services/cover/cover_service.h"
#include "qin_slot.h"
#include "ui_tool.h"
#include <stdint.h>

LV_FONT_DECLARE(font_puhui_18_4)

typedef enum { VIEW_HOME, VIEW_GAMES, VIEW_INTRO, VIEW_GAME, VIEW_SUCCESS,
               VIEW_COLLECTION, VIEW_EXHIBIT, VIEW_SETTINGS } view_t;
static struct {
    lv_obj_t *root;
    lv_timer_t *timer;
    view_t view;
    view_t settings_return;
    bool game_started;
    exploration_game_t game;
    exploration_snapshot_t snapshot;
    bool switching;
    qin_progress_t progress;
    qin_puzzle_t puzzle;
    const char *notice;
    int8_t hint_piece;
    uint32_t hint_until;
    uint32_t cover_revision;
    lv_obj_t *slots[3];
    lv_obj_t *instruction;
    struct {
        lv_obj_t *object;
        lv_point_t start;
        lv_point_t offset;
        lv_point_t origin;
        uint8_t piece;
        bool moved;
    } drag;
} pg;

static void render(void);
static const char *const game_names[] = {"秦俑归阵", "城门寻宝", "诗句补全"};
static const char *const reward_names[] = {"秦俑守护", "长安城门", "诗意长安"};
static const qin_art_id_t game_art[] = {QIN_ART_GUARDIAN, QIN_ART_GATE, QIN_ART_POEM};

static bool collected(void)
{
    return pg.game == GAME_QIN ? pg.progress.collected :
        (pg.snapshot.bonus_collected & (1u << (pg.game - 1))) != 0;
}

static void finish_switch(void *value)
{
    int direction = (int)(intptr_t)value;
    pg.switching = false;
    if (!pg.root || (pg.view != VIEW_GAMES && pg.view != VIEW_COLLECTION)) return;
    pg.game = (exploration_game_t)((pg.game + GAME_COUNT + direction) % GAME_COUNT);
    pg.notice = NULL;
    render();
}

static void swipe(lv_event_t *event)
{
    (void)event;
    if (pg.switching || (pg.view != VIEW_GAMES && pg.view != VIEW_COLLECTION)) return;
    lv_indev_t *input = lv_indev_active();
    if (!input) return;
    lv_dir_t direction = lv_indev_get_gesture_dir(input);
    if (direction != LV_DIR_LEFT && direction != LV_DIR_RIGHT) return;
    // 先结束本次按压，再换页；滑动结束不能误触主按钮。
    lv_indev_wait_release(input);
    pg.switching = true;
    lv_async_call(finish_switch, (void *)(intptr_t)(direction == LV_DIR_LEFT ? 1 : -1));
}

static void readable_text(lv_obj_t *object)
{
    // 正文约 23 像素；标题与主操作单独放大，避免长提示挤到圆屏边缘。
    lv_obj_set_style_text_font(object, &font_puhui_18_4, 0);
    lv_obj_set_style_transform_pivot_x(object, LV_PCT(50), 0);
    lv_obj_set_style_transform_pivot_y(object, LV_PCT(50), 0);
    lv_obj_set_style_transform_scale_x(object, 320, 0);
    lv_obj_set_style_transform_scale_y(object, 320, 0);
}

static lv_obj_t *label(const char *text, int y)
{
    lv_obj_t *obj = lv_label_create(pg.root);
    readable_text(obj);
    lv_obj_set_width(obj, 224);
    lv_obj_set_style_text_align(obj, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(obj, LV_ALIGN_TOP_MID, 0, y);
    lv_label_set_text(obj, text);
    return obj;
}

static void title(const char *text)
{
    lv_obj_t *object = label(text, 34);
    lv_obj_set_style_transform_scale_x(object, 448, 0);
    lv_obj_set_style_transform_scale_y(object, 448, 0);
    lv_obj_set_style_text_letter_space(object, 2, 0);
}

static void primary(lv_obj_t *object)
{
    lv_obj_set_style_bg_color(object, lv_color_hex(0x214b40), 0);
    lv_obj_set_style_border_color(object, lv_color_hex(0x4f7464), 0);
    lv_obj_set_style_border_width(object, 1, 0);
    lv_obj_set_style_text_color(object, lv_color_hex(0xfff7e7), 0);
    lv_obj_set_style_bg_color(object, lv_color_hex(0x173c32), LV_STATE_PRESSED);
}

static lv_obj_t *button(const char *text, int x, int y, int width,
                        lv_event_cb_t callback, intptr_t value)
{
    lv_obj_t *obj = lv_button_create(pg.root);
    lv_obj_set_size(obj, width, 54);
    lv_obj_set_pos(obj, x, y);
    lv_obj_set_style_bg_color(obj, lv_color_hex(0xf8eedb), 0);
    lv_obj_set_style_text_color(obj, lv_color_hex(0x263e30), 0);
    lv_obj_set_style_bg_color(obj, lv_color_hex(0xe2d0aa), LV_STATE_PRESSED);
    lv_obj_set_style_border_color(obj, lv_color_hex(0xd3ba90), 0);
    lv_obj_set_style_border_width(obj, text ? 1 : 0, 0);
    lv_obj_set_style_radius(obj, text ? 12 : 9, 0);
    lv_obj_set_style_shadow_width(obj, 0, 0);
    lv_obj_set_style_pad_all(obj, 0, 0);
    if (callback) lv_obj_add_event_cb(obj, callback, LV_EVENT_CLICKED, (void *)value);
    if (text) {
        lv_obj_t *caption = lv_label_create(obj);
        readable_text(caption);
        lv_label_set_text(caption, text);
        lv_obj_center(caption);
    }
    return obj;
}

// 原生图形素材：三块共同组成游戏示意兵俑，不依赖 SD 卡或外部授权图片。
static void shape(lv_obj_t *parent, int x, int y, int width, int height, int radius)
{
    lv_obj_t *obj = lv_obj_create(parent);
    lv_obj_remove_style_all(obj);
    lv_obj_set_pos(obj, x, y);
    lv_obj_set_size(obj, width, height);
    lv_obj_set_style_radius(obj, radius, 0);
    lv_obj_set_style_bg_color(obj, lv_color_hex(0xdba775), 0);
    lv_obj_set_style_bg_opa(obj, LV_OPA_COVER, 0);
    lv_obj_clear_flag(obj, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);
}

static void fragment(lv_obj_t *parent, unsigned piece)
{
    if (qin_art_add(parent, (qin_art_id_t)piece, 72, 46)) return;
    if (piece == 0) {
        shape(parent, 24, 5, 24, 32, 10);
        shape(parent, 16, 4, 40, 10, 3);
    } else if (piece == 1) {
        shape(parent, 13, 4, 46, 40, 5);
        for (int row = 0; row < 3; ++row)
            shape(parent, 20, 10 + row * 10, 32, 3, 0);
    } else {
        shape(parent, 17, 3, 15, 35, 3);
        shape(parent, 40, 3, 15, 35, 3);
        shape(parent, 12, 35, 22, 8, 2);
        shape(parent, 38, 35, 22, 8, 2);
    }
}

static void navigate(lv_event_t *event)
{
    view_t target = (view_t)(intptr_t)lv_event_get_user_data(event);
    pg.notice = NULL;
    if (target == VIEW_GAME) {
        if (pg.game != GAME_QIN) {
            exploration_snapshot(&pg.snapshot);
            bonus_round_t round = pg.snapshot.rounds[pg.game - 1];
            if ((!round.started || round.stage == bonus_total(pg.game)) &&
                exploration_bonus_begin(pg.game) != ESP_OK) {
                pg.notice = "暂不能开始，请重试";
                target = VIEW_INTRO;
            }
        } else {
        // 返回、设置和选游戏只暂停。只有首次开始或完成后的再玩才初始化拼图。
        qin_puzzle_t current;
        if (exploration_get(NULL, &current, NULL) != ESP_OK ||
            ((!pg.game_started || current.placed_mask == 7) && exploration_begin() != ESP_OK)) {
            pg.notice = "暂不能开始，请重试";
            target = VIEW_INTRO;
        } else {
            pg.game_started = true;
        }
        }
    }
    pg.view = target;
    render();
}

static void restart_game(lv_event_t *event)
{
    (void)event;
    if ((pg.game == GAME_QIN ? exploration_begin() : exploration_bonus_begin(pg.game)) != ESP_OK) {
        pg.notice = "暂不能重新开始";
    } else {
        pg.game_started = true;
        pg.hint_until = 0;
        pg.notice = NULL;
        pg.view = VIEW_GAME;
    }
    render();
}

static void open_settings(lv_event_t *event)
{
    (void)event;
    pg.settings_return = pg.view;
    pg.view = VIEW_SETTINGS;
    render();
}

static void close_settings(lv_event_t *event)
{
    (void)event;
    // 设置只是暂停界面，不调用 exploration_begin()，保留正在拼的碎片。
    pg.view = pg.settings_return;
    render();
}

static void save_setting(lv_event_t *event)
{
    int value = lv_slider_get_value(lv_event_get_target(event));
    if ((intptr_t)lv_event_get_user_data(event) == 0)
        ui_tool_set_brightness((uint8_t)value);
    else
        ui_tool_set_volume(value);
}

static void setting_slider(int y, int minimum, int value, intptr_t kind)
{
    lv_obj_t *slider = lv_slider_create(pg.root);
    lv_obj_set_size(slider, 180, 20);
    lv_obj_set_pos(slider, 90, y);
    lv_slider_set_range(slider, minimum, 100);
    lv_slider_set_value(slider, value, LV_ANIM_OFF);
    lv_obj_set_style_bg_color(slider, lv_color_hex(0xe4d8c0), LV_PART_MAIN);
    lv_obj_set_style_bg_color(slider, lv_color_hex(0xc4a574), LV_PART_INDICATOR);
    lv_obj_set_style_bg_color(slider, lv_color_hex(0xf5dfb6), LV_PART_KNOB);
    lv_obj_set_style_pad_all(slider, 5, LV_PART_KNOB);
    // 松手才保存，避免拖动时频繁写入非易失性存储。
    lv_obj_add_event_cb(slider, save_setting, LV_EVENT_RELEASED, (void *)kind);
}

static void place_piece(uint8_t piece, uint8_t slot)
{
    qin_result_t result;
    esp_err_t error = exploration_place(slot, &result);
    if (error != ESP_OK) {
        pg.notice = "保存失败，请重新拖放";
    } else if (result == QIN_COMPLETED || result == QIN_REPLAY_COMPLETED) {
        pg.view = VIEW_SUCCESS;
        pg.notice = result == QIN_COMPLETED ? "秦俑守护已收藏" : "再次完成，收藏保留";
    } else if (result == QIN_WRONG) {
        pg.notice = "看看轮廓，再试一次";
        qin_puzzle_t current;
        if (exploration_get(NULL, &current, NULL) == ESP_OK && current.mistakes >= 2) {
            pg.hint_piece = (int8_t)piece;
            pg.hint_until = lv_tick_get() + 1200;
        }
    } else if (result == QIN_INVALID) {
        pg.notice = "已有碎片，换个位置";
    } else {
        pg.notice = "放对了！继续拼接";
    }
    if (error == ESP_OK && (result == QIN_PLACED || result == QIN_COMPLETED ||
                            result == QIN_REPLAY_COMPLETED)) {
        ui_tool_play_game_sound();
    }
    render();
}

static int drop_slot(const lv_point_t *point)
{
    for (unsigned i = 0; i < 3; ++i) {
        lv_area_t bounds;
        lv_obj_get_coords(pg.slots[i], &bounds);
        if (point->x >= bounds.x1 && point->x <= bounds.x2 &&
            point->y >= bounds.y1 && point->y <= bounds.y2) return (int)i;
    }
    return -1;
}

static void drag_piece(lv_event_t *event)
{
    lv_event_code_t code = lv_event_get_code(event);
    if (code != LV_EVENT_PRESSED && code != LV_EVENT_PRESSING &&
        code != LV_EVENT_RELEASED && code != LV_EVENT_PRESS_LOST) return;
    lv_obj_t *object = lv_event_get_target(event);
    lv_indev_t *input = lv_event_get_indev(event);
    if (!input || lv_indev_get_type(input) != LV_INDEV_TYPE_POINTER) return;
    lv_point_t point;
    lv_indev_get_point(input, &point);

    if (code == LV_EVENT_PRESSED) {
        qin_result_t result;
        uint8_t piece = (uint8_t)(intptr_t)lv_event_get_user_data(event);
        if (exploration_select(piece, &result) != ESP_OK || result != QIN_PLACED) return;
        lv_area_t bounds;
        lv_obj_get_coords(object, &bounds);
        pg.drag.object = object;
        pg.drag.piece = piece;
        pg.drag.start = point;
        pg.drag.offset = (lv_point_t){point.x - bounds.x1, point.y - bounds.y1};
        pg.drag.origin = (lv_point_t){lv_obj_get_x(object), lv_obj_get_y(object)};
        pg.drag.moved = false;
        lv_obj_move_to_index(object, -1);
        lv_label_set_text(pg.instruction, "移入轮廓，再松手");
        return;
    }
    if (pg.drag.object != object) return;
    if (code == LV_EVENT_PRESSING) {
        int32_t dx = point.x - pg.drag.start.x;
        int32_t dy = point.y - pg.drag.start.y;
        if (dx * dx + dy * dy >= 36) pg.drag.moved = true;
        if (!pg.drag.moved) return;
        lv_area_t root;
        lv_obj_get_coords(pg.root, &root);
        // 保留按下位置相对碎片的偏移，避免刚按住就跳到手指中心。
        int32_t x = point.x - root.x1 - pg.drag.offset.x;
        int32_t y = point.y - root.y1 - pg.drag.offset.y;
        int32_t max_x = lv_obj_get_width(pg.root) - lv_obj_get_width(object);
        int32_t max_y = lv_obj_get_height(pg.root) - lv_obj_get_height(object);
        x = x < 0 ? 0 : (x > max_x ? max_x : x);
        y = y < 0 ? 0 : (y > max_y ? max_y : y);
        lv_obj_set_pos(object, x, y);
        int hovered = drop_slot(&point);
        for (unsigned i = 0; i < 3; ++i) {
            qin_slot_feedback(pg.slots[i], (pg.puzzle.placed_mask & (1u << i)) != 0,
                hovered == (int)i || (pg.hint_until && pg.hint_piece == (int8_t)i));
        }
        return;
    }

    // 失去按压只取消；点击、拖到轮廓外、松在已有碎片上均不得放置。
    int slot = code == LV_EVENT_RELEASED && pg.drag.moved ? drop_slot(&point) : -1;
    uint8_t piece = pg.drag.piece;
    lv_obj_set_pos(object, pg.drag.origin.x, pg.drag.origin.y);
    pg.drag.object = NULL;
    if (slot >= 0 && !(pg.puzzle.placed_mask & (1u << slot))) {
        place_piece(piece, (uint8_t)slot);
    } else {
        pg.notice = "按住碎片，拖入轮廓";
        render();
    }
}

static void exhibit(lv_event_t *event)
{
    (void)event;
    if (exploration_display_game(pg.game) == ESP_OK) {
        pg.view = VIEW_EXHIBIT;
        pg.notice = NULL;
    } else {
        pg.notice = "展示保存失败，请重试";
    }
    render();
}

static void answer(lv_event_t *event)
{
    bonus_result_t result;
    if (exploration_bonus_answer(pg.game, (uint8_t)(intptr_t)lv_event_get_user_data(event), &result) != ESP_OK) {
        pg.notice = "保存失败，请重试";
    } else if (result == BONUS_COMPLETED) {
        pg.view = VIEW_SUCCESS;
        pg.notice = "通关，已加入收藏";
        ui_tool_play_game_sound();
    } else if (result == BONUS_ADVANCED) {
        pg.notice = NULL;
        ui_tool_play_game_sound();
    } else {
        pg.notice = "再试一次";
    }
    render();
}

static bool art_card(qin_art_id_t art, int x, int y, int size)
{
    lv_obj_t *card = lv_obj_create(pg.root);
    lv_obj_remove_style_all(card);
    lv_obj_set_pos(card, x, y);
    lv_obj_set_size(card, size, size);
    lv_obj_clear_flag(card, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);
    return qin_art_add(card, art, size, size);
}

// 只为选择页添加展示表面；不改变寻宝图片坐标和拼图拖放区域。
static void selection_art(void)
{
    lv_obj_t *card = lv_obj_create(pg.root);
    lv_obj_remove_style_all(card);
    lv_obj_set_pos(card, 106, 62);
    lv_obj_set_size(card, 148, 148);
    lv_obj_set_style_bg_color(card, lv_color_hex(0xf3e5cb), 0);
    lv_obj_set_style_bg_opa(card, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(card, 18, 0);
    lv_obj_set_style_clip_corner(card, true, 0);
    lv_obj_set_style_border_color(card, lv_color_hex(0xc6a673), 0);
    lv_obj_set_style_border_width(card, 1, 0);
    lv_obj_set_style_border_post(card, true, 0);
    lv_obj_clear_flag(card, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);
    qin_art_add(card, game_art[pg.game], 140, 140);
}

static void page_markers(void)
{
    for (unsigned i = 0; i < GAME_COUNT; ++i) {
        lv_obj_t *dot = lv_obj_create(pg.root);
        lv_obj_remove_style_all(dot);
        lv_obj_set_pos(dot, 161 + (int)i * 16, 234);
        lv_obj_set_size(dot, i == (unsigned)pg.game ? 12 : 6, 4);
        lv_obj_set_style_radius(dot, 2, 0);
        lv_obj_set_style_bg_color(dot, lv_color_hex(i == (unsigned)pg.game ? 0xb64f32 : 0xd6c6a8), 0);
        lv_obj_set_style_bg_opa(dot, LV_OPA_COVER, 0);
        lv_obj_clear_flag(dot, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);
    }
}

static void render_bonus_game(void)
{
    bonus_round_t round = pg.snapshot.rounds[pg.game - 1];
    if (pg.game == GAME_GATE) {
        bool visible = art_card(QIN_ART_GATE, 80, 65, 200);
        // 图片坐标：门洞居中下方、旗在左上、鼓在右下；不使用与图片无关的假按钮。
        static const int regions[3][4] = {{155, 185, 60, 55}, {80, 65, 70, 90}, {225, 188, 55, 68}};
        static const char *const captions[] = {"城门", "红旗", "大鼓"};
        for (unsigned i = 0; i < 3; ++i) {
            if (!visible) {
                lv_obj_set_height(button(captions[i], 105, 85 + (int)i * 54, 150, answer, i), 46);
                continue;
            }
            lv_obj_t *target = button(NULL, regions[i][0], regions[i][1], regions[i][2], answer, i);
            lv_obj_set_height(target, regions[i][3]);
            lv_obj_set_style_bg_opa(target, LV_OPA_TRANSP, LV_PART_MAIN);
            lv_obj_set_style_bg_opa(target, LV_OPA_TRANSP, LV_PART_MAIN | LV_STATE_PRESSED);
        }
        static const char *const hints[] = {"找到城门", "找到红旗", "找到大鼓"};
        label(pg.notice ? pg.notice : hints[round.stage < 3 ? round.stage : 2], 253);
    } else {
        art_card(QIN_ART_POEM, 136, 67, 88);
        label(round.stage == 0 ? "床前明月光" : "白日依山尽", 166);
        label(pg.notice ? pg.notice : "选出下一句", 198);
        const char *choices[2] = {round.stage == 0 ? "疑是地上霜" : "举头望明月",
                                 "黄河入海流"};
        lv_obj_set_height(button(choices[0], 55, 233, 122, answer, 0), 42);
        lv_obj_set_height(button(choices[1], 183, 233, 122, answer, 1), 42);
    }
    lv_obj_set_height(button("退出", 78, 291, 98, navigate, VIEW_GAMES), 44);
    lv_obj_set_height(button("设置", 184, 291, 98, open_settings, 0), 44);
}

static void render(void)
{
    if (!pg.root) return;
    static const exploration_screen_t screens[] = {
        EXPLORATION_COVER, EXPLORATION_SELECTION, EXPLORATION_INTRO, EXPLORATION_PLAYING,
        EXPLORATION_RESULT, EXPLORATION_COLLECTION, EXPLORATION_EXHIBIT, EXPLORATION_SETTINGS};
    exploration_set_screen(screens[pg.view]);
    exploration_set_game(pg.game);
    pg.drag.object = NULL;
    pg.instruction = NULL;
    lv_obj_clean(pg.root);
    if (pg.view == VIEW_SETTINGS) {
        title("游戏设置");
        label("亮度", 100);
        setting_slider(145, 10, ui_tool_get_brightness(), 0);
        label("音量", 190);
        setting_slider(235, 0, ui_tool_get_volume(), 1);
        primary(button("返回", 110, 278, 140, close_settings, 0));
        return;
    }
    if (exploration_get(&pg.progress, &pg.puzzle, NULL) != ESP_OK) {
        label("进度存储不可用", 130);
        button("设置", 110, 220, 140, open_settings, 0);
        return;
    }
    exploration_snapshot(&pg.snapshot);
    if (pg.view == VIEW_HOME && !cover_image_add(pg.root, &pg.cover_revision))
        qin_art_add(pg.root, QIN_ART_COVER, 360, 360);
    title(pg.view == VIEW_GAME || pg.view == VIEW_INTRO ? game_names[pg.game] :
          pg.view == VIEW_GAMES ? "选择游戏" : pg.view == VIEW_SUCCESS ? "通关成功" :
          pg.view == VIEW_COLLECTION ? "我的收藏" : "长安游迹");
    if (pg.view == VIEW_GAME) {
        if (pg.game != GAME_QIN) { render_bonus_game(); return; }
        const int piece_x[] = {48, 240, 48};
        const int piece_y[] = {176, 110, 110};
        for (unsigned i = 0; i < 3; ++i) {
            lv_obj_t *slot = button(NULL, 144, 88 + (int)i * 48, 72, NULL, 0);
            pg.slots[i] = slot;
            lv_obj_clear_flag(slot, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);
            lv_obj_set_height(slot, 46);
            qin_slot_feedback(slot, (pg.puzzle.placed_mask & (1u << i)) != 0,
                              pg.hint_until && pg.hint_piece == (int8_t)i);
            if (pg.puzzle.placed_mask & (1u << i)) {
                fragment(slot, i);
            } else {
                fragment(slot, i);
                lv_obj_set_style_opa(slot, LV_OPA_50, 0);
                lv_obj_t *piece = button(NULL, piece_x[i], piece_y[i], 72, NULL, 0);
                // 保持按压归属，手指离开原位置后仍收到移动与松手事件。
                lv_obj_add_flag(piece, LV_OBJ_FLAG_PRESS_LOCK);
                lv_obj_clear_flag(piece, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_GESTURE_BUBBLE);
                lv_obj_add_event_cb(piece, drag_piece, LV_EVENT_ALL, (void *)(intptr_t)i);
                fragment(piece, i);
            }
        }
        pg.instruction = label(pg.notice ? pg.notice : "拖入轮廓", 244);
        button("退出", 78, 280, 98, navigate, VIEW_GAMES);
        button("设置", 184, 280, 98, open_settings, 0);
    } else if (pg.view == VIEW_SUCCESS) {
        lv_obj_t *art = lv_obj_create(pg.root);
        lv_obj_remove_style_all(art);
        lv_obj_set_pos(art, 108, 76);
        lv_obj_set_size(art, 144, 130);
        lv_obj_clear_flag(art, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);
        qin_art_add(art, pg.game == GAME_QIN ? QIN_ART_REWARD : game_art[pg.game], 144, 130);
        label(pg.notice ? pg.notice : "通关，已加入收藏", 208);
        lv_obj_t *display = button("设为展示", 70, 238, 220, exhibit, 0);
        primary(display);
        lv_obj_set_height(display, 48);
        lv_obj_set_height(button("查看收藏", 78, 291, 98, navigate, VIEW_COLLECTION), 44);
        lv_obj_set_height(button("选游戏", 184, 291, 98, navigate, VIEW_GAMES), 44);
    } else if (pg.view == VIEW_COLLECTION || pg.view == VIEW_EXHIBIT) {
        if (collected()) {
            lv_obj_t *art = button(NULL, 80, 80, 200, navigate, VIEW_COLLECTION);
            lv_obj_set_height(art, 160);
            lv_obj_set_style_bg_opa(art, LV_OPA_TRANSP, 0);
            lv_obj_set_style_border_width(art, 0, 0);
            lv_obj_clear_flag(art, LV_OBJ_FLAG_SCROLLABLE);
            qin_art_add(art, pg.game == GAME_QIN ? QIN_ART_REWARD : game_art[pg.game], 200, 160);
            label(pg.notice ? pg.notice : reward_names[pg.game], 240);
            if (pg.view == VIEW_COLLECTION) {
                lv_obj_t *display = button("设为展示", 65, 276, 140, exhibit, 0);
                primary(display);
                lv_obj_set_height(display, 44);
                lv_obj_set_height(button("返回", 215, 276, 80, navigate, VIEW_GAMES), 44);
            }
            else
                button("首页", 110, 276, 140, navigate, VIEW_HOME);
        } else {
            art_card(game_art[pg.game], 116, 80, 128);
            label("通关后收藏 · 左右滑动", 225);
            button("返回", 110, 276, 140, navigate, VIEW_GAMES);
        }
    } else if (pg.view == VIEW_GAMES || pg.view == VIEW_INTRO) {
        selection_art();
        static const char *const indicators[] = {"1 / 3 · 左右滑动", "2 / 3 · 左右滑动", "3 / 3 · 左右滑动"};
        static const char *const descriptions[] = {"拖动三片，拼回秦俑", "按提示找门、旗、鼓", "补全两句唐诗"};
        lv_obj_t *status = label(pg.notice ? pg.notice : pg.view == VIEW_GAMES ? indicators[pg.game] :
            descriptions[pg.game], 210);
        lv_obj_set_style_transform_scale_x(status, 256, 0);
        lv_obj_set_style_transform_scale_y(status, 256, 0);
        lv_obj_set_style_text_color(status, lv_color_hex(0x6e654d), 0);
        if (pg.view == VIEW_GAMES) page_markers();
        bool resume = pg.game == GAME_QIN ? pg.game_started && pg.puzzle.placed_mask != 7 :
            pg.snapshot.rounds[pg.game - 1].started && pg.snapshot.rounds[pg.game - 1].stage < bonus_total(pg.game);
        lv_obj_t *play = button(pg.view == VIEW_GAMES ? game_names[pg.game] :
            (resume ? "继续游戏" : collected() ? "再玩一次" : "开始游戏"),
            80, 242, 200, navigate, pg.view == VIEW_GAMES ? VIEW_INTRO : VIEW_GAME);
        lv_obj_set_height(play, 40);
        primary(play);
        lv_obj_t *caption = lv_obj_get_child(play, 0);
        lv_obj_set_style_transform_scale_x(caption, 352, 0);
        lv_obj_set_style_transform_scale_y(caption, 352, 0);
        lv_obj_set_height(button(pg.view == VIEW_GAMES ? "封面" : "返回", 82, 286, 94,
            navigate, pg.view == VIEW_GAMES ? VIEW_HOME : VIEW_GAMES), 44);
        if (pg.view == VIEW_INTRO && resume && (pg.game != GAME_QIN || pg.puzzle.placed_mask))
            lv_obj_set_height(button("重新开始", 184, 286, 94, restart_game, 0), 44);
        else
            lv_obj_set_height(button("收藏", 184, 286, 94, navigate, VIEW_COLLECTION), 44);
    } else {
        lv_obj_t *caption = label("一枚腰牌，一城故事", 78);
        lv_obj_set_style_transform_scale_x(caption, 256, 0);
        lv_obj_set_style_transform_scale_y(caption, 256, 0);
        lv_obj_t *play = button("开始探索", 80, 235, 200, navigate, VIEW_GAMES);
        primary(play);
        lv_obj_set_height(play, 50);
        lv_obj_set_height(button("收藏", 82, 292, 94, navigate, VIEW_COLLECTION), 44);
        lv_obj_set_height(button("设置", 184, 292, 94, open_settings, 0), 44);
    }
}

static void poll(lv_timer_t *timer)
{
    (void)timer;
    // 定时提示及远程进度不能在拖动中删掉手指正在操作的对象。
    if (pg.drag.object || pg.view == VIEW_SETTINGS) return;
    if (pg.view == VIEW_HOME && pg.cover_revision != cover_service_revision()) {
        render();
        return;
    }
    if (pg.hint_until && (int32_t)(lv_tick_get() - pg.hint_until) >= 0) {
        pg.hint_until = 0;
        render();
    }
    qin_progress_t value;
    if (exploration_get(&value, NULL, NULL) == ESP_OK &&
        (value.unlocked != pg.progress.unlocked || value.completed != pg.progress.completed)) {
        pg.notice = NULL;
        render();
    }
}

static void load(page_base_t *self)
{
    pg.root = self->root;
    pg.view = VIEW_HOME;
    pg.game_started = false;
    pg.game = GAME_QIN;
    pg.switching = false;
    pg.notice = NULL;
    pg.hint_piece = -1;
    pg.hint_until = 0;
    lv_obj_remove_style_all(pg.root);
    lv_obj_set_size(pg.root, 360, 360);
    lv_obj_set_style_bg_color(pg.root, lv_color_hex(0xfaf3e3), 0);
    lv_obj_set_style_bg_opa(pg.root, LV_OPA_COVER, 0);
    lv_obj_set_style_text_color(pg.root, lv_color_hex(0x263e30), 0);
    lv_obj_set_style_text_font(pg.root, &font_puhui_18_4, 0);
    lv_obj_set_style_radius(pg.root, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_clip_corner(pg.root, true, 0);
    lv_obj_set_style_border_color(pg.root, lv_color_hex(0xb99861), 0);
    lv_obj_set_style_border_width(pg.root, 2, 0);
    lv_obj_set_style_border_post(pg.root, true, 0);
    lv_obj_clear_flag(pg.root, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_GESTURE_BUBBLE);
    lv_obj_remove_event_cb(pg.root, swipe);
    lv_obj_add_event_cb(pg.root, swipe, LV_EVENT_GESTURE, NULL);
    render();
    pg.timer = lv_timer_create(poll, 300, NULL);
}

static void unload(page_base_t *self)
{
    (void)self;
    if (pg.timer) lv_timer_delete(pg.timer);
    pg.timer = NULL;
    pg.drag.object = NULL;
    pg.instruction = NULL;
    pg.root = NULL;
    lv_async_call_cancel(finish_switch, (void *)(intptr_t)1);
    lv_async_call_cancel(finish_switch, (void *)(intptr_t)-1);
}

static void configure(page_base_t *self)
{
    page_set_custom_cache_enable(self, false);
    page_set_custom_load_anim_type(self, LOAD_ANIM_NONE, 0, lv_anim_path_ease_out);
}

// 现有页面管理器无条件调用全部生命周期回调，未使用的阶段也必须提供实现。
static void ignore_lifecycle(page_base_t *self)
{
    (void)self;
}

page_vtable_t *exploration_create(const char *name)
{
    (void)name;
    static page_vtable_t table = {
        .on_custom_attr_config = configure, .on_view_load = load,
        .on_view_did_load = ignore_lifecycle,
        .on_view_will_appear = ignore_lifecycle,
        .on_view_did_appear = ignore_lifecycle,
        .on_view_will_disappear = ignore_lifecycle,
        .on_view_did_disappear = ignore_lifecycle,
        .on_view_did_unload = unload};
    return &table;
}

REGIST_PAGE(exploration)
