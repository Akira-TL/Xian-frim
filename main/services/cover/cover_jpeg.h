#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
// 完整解码验证360×360基线JPEG；可同时输出RGB565显示缓冲。
bool cover_jpeg_decode(const uint8_t *data,size_t size,uint16_t *pixels);
