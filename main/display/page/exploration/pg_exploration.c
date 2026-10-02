#include "lvgl.h"
#include "cl_ui.h"
#include "services/exploration/exploration.h"
#include <stdint.h>

LV_FONT_DECLARE(font_puhui_18_4)

typedef enum { VIEW_HOME, VIEW_GAME, VIEW_COLLECTION, VIEW_EXHIBIT } view_t;
static struct {
    lv_obj_t *root;
    lv_timer_t *timer;
    view_t view;
    qin_progress_t progress;
    qin_puzzle_t puzzle;
    const char *notice;
    int8_t hint_piece;
    uint32_t hint_until;
} pg;

static void render(void);

static void readable_text(lv_obj_t *object)
{
    // 使用完整中文字体并统一放大至约 27 像素，避免备用字形退到 14 像素。
    lv_obj_set_style_text_font(object, &font_puhui_18_4, 0);
    lv_obj_set_style_transform_pivot_x(object, LV_PCT(50), 0);
    lv_obj_set_style_transform_pivot_y(object, LV_PCT(50), 0);
    lv_obj_set_style_transform_scale_x(object, 384, 0);
    lv_obj_set_style_transform_scale_y(object, 384, 0);
}

static lv_obj_t *label(const char *text, int y)
{
    lv_obj_t *obj = lv_label_create(pg.root);
    readable_text(obj);
    lv_obj_set_width(obj, 260);
    lv_obj_set_style_text_align(obj, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(obj, LV_ALIGN_TOP_MID, 0, y);
    lv_label_set_text(obj, text);
    return obj;
}

static lv_obj_t *button(const char *text, int x, int y, int width,
                        lv_event_cb_t callback, intptr_t value)
{
    lv_obj_t *obj = lv_button_create(pg.root);
    lv_obj_set_size(obj, width, 54);
    lv_obj_set_pos(obj, x, y);
    lv_obj_set_style_bg_color(obj, lv_color_hex(0x694631), 0);
    lv_obj_set_style_pad_all(obj, 0, 0);
    lv_obj_add_event_cb(obj, callback, LV_EVENT_CLICKED, (void *)value);
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
    if (target == VIEW_GAME && exploration_begin() != ESP_OK) {
        pg.notice = "请先到点扫码解锁";
        target = VIEW_HOME;
    }
    pg.view = target;
    render();
}

static void return_settings(lv_event_t *event)
{
    (void)event;
    page_change("app_list");
}

static void select_piece(lv_event_t *event)
{
    qin_result_t result;
    esp_err_t error = exploration_select((uint8_t)(intptr_t)lv_event_get_user_data(event), &result);
    pg.notice = error == ESP_OK && result == QIN_PLACED ? "再点击对应的轮廓" : "请重新选择";
    render();
}

static void place_piece(lv_event_t *event)
{
    qin_result_t result;
    esp_err_t error = exploration_place((uint8_t)(intptr_t)lv_event_get_user_data(event), &result);
    if (error != ESP_OK) {
        pg.notice = "保存失败，请再点一次";
    } else if (result == QIN_COMPLETED || result == QIN_REPLAY_COMPLETED) {
        pg.view = VIEW_COLLECTION;
        pg.notice = result == QIN_COMPLETED ? "通关！奖励已收藏" : "再次完成，不重复发奖";
    } else if (result == QIN_WRONG) {
        pg.notice = "看看轮廓，再试一次";
        qin_puzzle_t current;
        if (exploration_get(NULL, &current, NULL) == ESP_OK && current.mistakes >= 2) {
            pg.hint_piece = pg.puzzle.selected_piece;
            pg.hint_until = lv_tick_get() + 1200;
        }
    } else if (result == QIN_INVALID) {
        pg.notice = "先选碎片，再选轮廓";
    } else {
        pg.notice = "放对了！继续拼接";
    }
    render();
}

static void exhibit(lv_event_t *event)
{
    (void)event;
    if (exploration_exhibit() == ESP_OK) {
        pg.view = VIEW_EXHIBIT;
        pg.notice = NULL;
    } else {
        pg.notice = "展示保存失败，请重试";
    }
    render();
}

static void render(void)
{
    if (!pg.root) return;
    lv_obj_clean(pg.root);
    if (exploration_get(&pg.progress, &pg.puzzle, NULL) != ESP_OK) {
        label("进度存储不可用", 130);
        button("设置", 110, 220, 140, return_settings, 0);
        return;
    }
    label(pg.view == VIEW_GAME ? "秦俑归阵" : "长安游迹", 45);
    if (pg.view == VIEW_GAME) {
        const int piece_x[] = {48, 240, 48};
        const int piece_y[] = {176, 110, 110};
        for (unsigned i = 0; i < 3; ++i) {
            lv_obj_t *slot = button(NULL, 144, 88 + (int)i * 48, 72, place_piece, i);
            lv_obj_set_height(slot, 46);
            lv_obj_set_style_border_width(slot, 2, 0);
            lv_obj_set_style_border_color(slot, lv_color_hex(0xb59573), 0);
            if (pg.puzzle.placed_mask & (1u << i)) {
                fragment(slot, i);
                lv_obj_add_state(slot, LV_STATE_DISABLED);
            } else {
                fragment(slot, i);
                lv_obj_set_style_opa(slot, LV_OPA_50, 0);
                if (pg.hint_until && pg.hint_piece == (int8_t)i) {
                    lv_obj_set_style_border_color(slot, lv_color_hex(0xffdc75), 0);
                    lv_obj_set_style_border_width(slot, 4, 0);
                }
                lv_obj_t *piece = button(NULL, piece_x[i], piece_y[i], 72, select_piece, i);
                fragment(piece, i);
                if (pg.puzzle.selected_piece == (int8_t)i) {
                    lv_obj_set_style_border_width(piece, 3, 0);
                    lv_obj_set_style_border_color(piece, lv_color_hex(0xffdc75), 0);
                }
            }
        }
        label(pg.notice ? pg.notice : "先选碎片，再选轮廓", 244);
        button("退出", 110, 280, 140, navigate, VIEW_HOME);
    } else if (pg.view == VIEW_COLLECTION || pg.view == VIEW_EXHIBIT) {
        if (pg.progress.collected) {
            lv_obj_t *art = button(NULL, 144, 90, 72, navigate, VIEW_COLLECTION);
            lv_obj_set_height(art, 142);
            fragment(art, 0);
            lv_obj_t *body = lv_obj_create(art);
            lv_obj_remove_style_all(body);
            lv_obj_set_pos(body, 0, 46);
            lv_obj_set_size(body, 72, 96);
            fragment(body, 1);
            lv_obj_t *legs = lv_obj_create(body);
            lv_obj_remove_style_all(legs);
            lv_obj_set_pos(legs, 0, 46);
            lv_obj_set_size(legs, 72, 48);
            fragment(legs, 2);
            label(pg.notice ? pg.notice : "秦俑守护", 240);
            if (pg.view == VIEW_COLLECTION)
                button("设为展示", 80, 276, 200, exhibit, 0);
            else
                button("首页", 110, 276, 140, navigate, VIEW_HOME);
        } else {
            label("通关后收藏秦俑奖励", 140);
            button("首页", 110, 260, 140, navigate, VIEW_HOME);
        }
    } else {
        label(pg.notice ? pg.notice : (pg.progress.unlocked ? "秦俑工坊已解锁" : "到点后出示背面二维码"), 100);
        lv_obj_t *play = button(pg.progress.completed ? "重玩秦俑归阵" : "开始秦俑归阵", 70, 148, 220, navigate, VIEW_GAME);
        if (!pg.progress.unlocked) lv_obj_add_state(play, LV_STATE_DISABLED);
        button("收藏", 70, 214, 106, navigate, VIEW_COLLECTION);
        button("设置", 184, 214, 106, return_settings, 0);
        if (pg.progress.exhibiting)
            button("展示", 110, 280, 140, navigate, VIEW_EXHIBIT);
    }
}

static void poll(lv_timer_t *timer)
{
    (void)timer;
    if (pg.hint_until && (int32_t)(lv_tick_get() - pg.hint_until) >= 0) {
        pg.hint_until = 0;
        render();
    }
    qin_progress_t value;
    if (exploration_get(&value, NULL, NULL) == ESP_OK &&
        (value.unlocked != pg.progress.unlocked || value.completed != pg.progress.completed)) {
        pg.notice = value.unlocked ? "游戏已解锁，点击开始" : NULL;
        render();
    }
}

static void load(page_base_t *self)
{
    pg.root = self->root;
    pg.view = VIEW_HOME;
    pg.notice = NULL;
    pg.hint_piece = -1;
    pg.hint_until = 0;
    lv_obj_remove_style_all(pg.root);
    lv_obj_set_size(pg.root, 360, 360);
    lv_obj_set_style_bg_color(pg.root, lv_color_hex(0x211c18), 0);
    lv_obj_set_style_bg_opa(pg.root, LV_OPA_COVER, 0);
    lv_obj_set_style_text_color(pg.root, lv_color_hex(0xffecd6), 0);
    lv_obj_set_style_text_font(pg.root, &font_puhui_18_4, 0);
    lv_obj_clear_flag(pg.root, LV_OBJ_FLAG_SCROLLABLE);
    render();
    pg.timer = lv_timer_create(poll, 300, NULL);
}

static void unload(page_base_t *self)
{
    (void)self;
    if (pg.timer) lv_timer_delete(pg.timer);
    pg.timer = NULL;
    pg.root = NULL;
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
