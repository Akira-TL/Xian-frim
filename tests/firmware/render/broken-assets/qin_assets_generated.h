#pragma once
// 故意损坏的素材，仅作为第二个测试可执行文件的输入，不进入固件。
static const uint8_t broken_data[] = {99, 0, 0, 0, 1, 0, 0, 0, 16, 0, 0, 0, 0};
#define BROKEN_IMAGE(name, format, width, length) \
    static const lv_image_dsc_t name = { \
        .header = {.magic = LV_IMAGE_HEADER_MAGIC, .cf = format, \
            .flags = LV_IMAGE_FLAGS_COMPRESSED, .w = width, .h = 2, .stride = width * 4}, \
        .data_size = length, .data = broken_data};
BROKEN_IMAGE(incompatible, LV_COLOR_FORMAT_UNKNOWN, 2, sizeof(broken_data))
BROKEN_IMAGE(truncated, LV_COLOR_FORMAT_ARGB8888, 2, 3)
BROKEN_IMAGE(bad_compression, LV_COLOR_FORMAT_ARGB8888, 2, sizeof(broken_data))
BROKEN_IMAGE(bad_dimensions, LV_COLOR_FORMAT_ARGB8888, 0, sizeof(broken_data))
static const lv_image_dsc_t *const qin_images[QIN_ART_COUNT] = {
    NULL, &incompatible, &truncated, &bad_compression,
    &truncated, &bad_dimensions, &bad_compression, &incompatible};
#undef BROKEN_IMAGE
