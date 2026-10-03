#include "qin_slot.h"

void qin_slot_feedback(lv_obj_t *slot, bool placed, bool highlighted)
{
    lv_obj_set_style_border_color(slot, lv_color_hex(
        placed || highlighted ? 0xffdc75 : 0xb59573), 0);
    lv_obj_set_style_border_width(slot, placed ? 4 : highlighted ? 3 : 2, 0);
    // 图片与槽同尺寸，边框最后绘制，避免被子图片盖住。
    lv_obj_set_style_border_post(slot, true, 0);
}
