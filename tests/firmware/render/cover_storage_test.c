#include "services/cover/cover_transfer.h"
#include "services/cover/cover_jpeg.h"
#include "cover_image.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint8_t flash[2 * COVER_BANK_BYTES];
static int fail_after = -1;
static cover_transfer_t state;
static bool fail(void) { return fail_after == 0 || (fail_after > 0 && --fail_after == 0); }
static bool read_flash(void *context, uint32_t at, void *out, size_t size)
{
    (void)context;
    assert(at <= sizeof(flash) && size <= sizeof(flash) - at);
    if (fail()) return false;
    memcpy(out, flash + at, size); return true;
}
static bool write_flash(void *context, uint32_t at, const void *data, size_t size)
{
    (void)context;
    assert(at <= sizeof(flash) && size <= sizeof(flash) - at);
    if (fail()) return false;
    const uint8_t *bytes = data;
    for (size_t i = 0; i < size; ++i) {
        assert((flash[at + i] & bytes[i]) == bytes[i]);
        flash[at + i] &= bytes[i];
    }
    return true;
}
static bool erase_flash(void *context, uint32_t at, size_t size)
{
    (void)context;
    assert(at % 4096 == 0 && size % 4096 == 0 && at + size <= sizeof(flash));
    if (fail()) return false;
    memset(flash + at, 255, size); return true;
}
static bool validate(const uint8_t *data, size_t size) { return cover_jpeg_decode(data, size, NULL); }
static cover_io_t io = {.read = read_flash, .write = write_flash, .erase = erase_flash, .validate = validate};
uint32_t cover_service_revision(void) { return state.revision; }
bool cover_service_copy(uint8_t **data, size_t *size, uint32_t *revision)
{ *revision = state.revision; return cover_transfer_copy(&state, data, size); }
static void put32(uint8_t *data, uint32_t value)
{ for (unsigned i = 0; i < 4; ++i) data[i] = value >> (i * 8); }
static void command(uint8_t op, uint32_t id)
{
    uint8_t packet[7] = {'P', 1, op}; put32(packet + 3, id);
    cover_transfer_packet(&state, packet, sizeof(packet), 100);
}
static void receive(const uint8_t *image, size_t size, uint32_t id, bool wrong_crc)
{
    uint8_t begin[15] = {'P', 1, 1}; put32(begin + 3, id); put32(begin + 7, size);
    put32(begin + 11, cover_crc32(image, size) ^ wrong_crc);
    cover_transfer_packet(&state, begin, sizeof(begin), 100);
    assert(state.code == COVER_RECEIVING);
    for (size_t at = 0; at < size;) {
        size_t count = size - at < COVER_CHUNK_BYTES ? size - at : COVER_CHUNK_BYTES;
        uint8_t packet[11 + COVER_CHUNK_BYTES] = {'P', 1, 2};
        put32(packet + 3, id); put32(packet + 7, at);
        memcpy(packet + 11, image + at, count);
        cover_transfer_packet(&state, packet, count + 11, 100);
        assert(state.code == COVER_RECEIVING); at += count;
    }
}
static uint8_t *load(const char *directory, const char *name, size_t *size)
{
    char path[1024]; snprintf(path, sizeof(path), "%s/%s.jpg", directory, name);
    FILE *file = fopen(path, "rb"); assert(file);
    assert(fseek(file, 0, SEEK_END) == 0); long length = ftell(file);
    assert(length > 0 && length <= COVER_MAX_BYTES); *size = length;
    rewind(file); uint8_t *data = malloc(*size); assert(data);
    assert(fread(data, 1, *size, file) == *size); fclose(file); return data;
}
static void flush(lv_display_t *display, const lv_area_t *area, uint8_t *pixels)
{ (void)area; (void)pixels; lv_display_flush_ready(display); }
int main(int argc, char **argv)
{
    assert(argc == 2 || argc == 3);
    if (argc == 3) {
        size_t browser_size;
        uint8_t *browser = load(argv[2], "cover-browser", &browser_size);
        assert(validate(browser, browser_size));
        free(browser);
        puts("真实浏览器导出的圆屏 JPEG 通过固件解码校验");
    }
    size_t red_size, green_size, other_size;
    uint8_t *red = load(argv[1], "red", &red_size), *green = load(argv[1], "green", &green_size);
    uint8_t *other = load(argv[1], "wrong-size", &other_size);
    assert(!validate(other, other_size)); free(other);
    other = load(argv[1], "progressive", &other_size);
    assert(!validate(other, other_size)); free(other);
    assert(validate(red, red_size) && validate(green, green_size));
    assert(!validate(red, red_size - 2));
    assert(cover_crc32((const uint8_t *)"123456789", 9) == 0xcbf43926u);
    memset(flash, 255, sizeof(flash)); assert(cover_transfer_init(&state, io));
    receive(red, red_size, 1, false); command(3, 1);
    assert(state.code == COVER_SAVED && state.saved_size == red_size && state.revision == 1);
    assert(cover_transfer_init(&state, io) && state.saved_crc == cover_crc32(red, red_size));

    receive(green, green_size, 2, true); command(3, 2);
    assert(state.code == COVER_CHECKSUM && state.revision == 1);
    receive(green, green_size, 3, false); command(4, 3);
    assert(state.code == COVER_CANCELLED && !state.pending && state.revision == 1);
    receive(green, green_size, 4, false);
    uint8_t status[24]; cover_transfer_status(&state, status, 30101);
    assert(state.code == COVER_TIMEOUT && !state.pending && state.revision == 1);
    receive(green, green_size, 5, false);
    command(3, 6); assert(state.code == COVER_INVALID && state.pending);
    uint8_t wrong_offset[12] = {'P', 1, 2}; put32(wrong_offset + 3, 5);
    put32(wrong_offset + 7, 0);
    cover_transfer_packet(&state, wrong_offset, sizeof(wrong_offset), 100);
    assert(state.code == COVER_INVALID && state.received == green_size);
    command(4, 5);
    uint8_t too_large[15] = {'P', 1, 1}; put32(too_large + 3, 6); put32(too_large + 7, COVER_MAX_BYTES + 1);
    cover_transfer_packet(&state, too_large, sizeof(too_large), 100);
    assert(state.code == COVER_INVALID && !state.pending);
    uint8_t corrupt[12] = {255, 216, 1, 2, 3, 4, 5, 6, 7, 8, 255, 217};
    receive(corrupt, sizeof(corrupt), 7, false); command(3, 7);
    assert(state.code == COVER_IMAGE && state.revision == 1);

    // 模拟擦除、负载写入、回读、提交头写入各阶段失败；旧图在重启后仍可读。
    uint8_t original[sizeof(flash)]; memcpy(original, flash, sizeof(flash));
    for (int point = 1; point <= 4; ++point) {
        memcpy(flash, original, sizeof(flash)); assert(cover_transfer_init(&state, io));
        receive(green, green_size, 8, false); fail_after = point; command(3, 8); fail_after = -1;
        assert(state.code == COVER_STORAGE && state.revision == 1);
        assert(cover_transfer_init(&state, io) && state.saved_crc == cover_crc32(red, red_size));
    }
    receive(green, green_size, 9, false); command(3, 9);
    assert(state.code == COVER_SAVED && state.revision == 2);
    assert(cover_transfer_init(&state, io) && state.saved_crc == cover_crc32(green, green_size));
    // 最新存储槽损坏时选择仍有效的上一张图，而不是显示坏图或清空存档。
    uint32_t latest = (uint32_t)state.bank * COVER_BANK_BYTES + COVER_DATA_OFFSET;
    uint8_t saved_byte = flash[latest]; flash[latest] ^= 1;
    cover_transfer_t recovered;
    assert(cover_transfer_init(&recovered, io) && recovered.saved_crc == cover_crc32(red, red_size));
    flash[latest] = saved_byte;

    // 使用真正的解码器、封面绘制函数和 LVGL 屏幕缓冲验证，不只检查文件存在。
    lv_init(); lv_display_t *display = lv_display_create(360, 360);
    static uint16_t pixels[360 * 360];
    lv_display_set_color_format(display, LV_COLOR_FORMAT_RGB565);
    lv_display_set_buffers(display, pixels, NULL, sizeof(pixels), LV_DISPLAY_RENDER_MODE_DIRECT);
    lv_display_set_flush_cb(display, flush);
    uint32_t revision;
    assert(cover_image_add(lv_screen_active(), &revision) && revision == 2);
    lv_refr_now(display);
    uint16_t center = pixels[180 * 360 + 180];
    assert(((center >> 5) & 63) > 35 && ((center >> 11) & 31) < 12);
    lv_obj_clean(lv_screen_active());
    command(5, 10); assert(state.code == COVER_SAVED && state.saved_size == 0 && state.revision == 3);
    assert(cover_transfer_init(&state, io) && state.saved_size == 0 && state.revision == 3);
    assert(!cover_image_add(lv_screen_active(), &revision));
    lv_display_delete(display); lv_deinit();
    free(red); free(green);
    puts("封面真实解码、绘制、双槽持久化及失败保护测试通过");
    return 0;
}
