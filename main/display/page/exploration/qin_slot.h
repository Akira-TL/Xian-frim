#pragma once

#include "lvgl.h"

// 正确碎片持续亮边；悬停／提示仅强调未放置槽。
void qin_slot_feedback(lv_obj_t *slot, bool placed, bool highlighted);
