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

// 有图片则按比例放入指定区域；缺图返回 false，由页面显示占位图。
bool qin_art_add(lv_obj_t *parent, qin_art_id_t id, int width, int height);
