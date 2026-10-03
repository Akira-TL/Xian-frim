#pragma once

#include "lvgl.h"

typedef enum {
    QIN_ART_HEAD,
    QIN_ART_BODY,
    QIN_ART_LEGS,
    QIN_ART_REWARD,
    QIN_ART_GUARDIAN,
    QIN_ART_COVER,
    QIN_ART_GATE,
    QIN_ART_POEM,
    QIN_ART_COUNT
} qin_art_id_t;

// 返回真实素材是否可用。碎片失败由页面绘制对应轮廓；其他素材失败自动显示通用章。
bool qin_art_add(lv_obj_t *parent, qin_art_id_t id, int width, int height);
