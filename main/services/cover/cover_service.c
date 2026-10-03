#include "cover_service.h"
#include "cover_transfer.h"
#include "cover_jpeg.h"
#include "esp_partition.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include <string.h>

static SemaphoreHandle_t mutex;
static cover_transfer_t state;
static uint16_t owner = UINT16_MAX;
static bool ready;
static esp_timer_handle_t timeout_timer;

static bool read_flash(void *context, uint32_t offset, void *data, size_t size)
{
    return esp_partition_read(context, offset, data, size) == ESP_OK;
}
static bool write_flash(void *context, uint32_t offset, const void *data, size_t size)
{
    return esp_partition_write(context, offset, data, size) == ESP_OK;
}
static bool erase_flash(void *context, uint32_t offset, size_t size)
{
    return esp_partition_erase_range(context, offset, size) == ESP_OK;
}
static bool validate(const uint8_t *data, size_t size)
{
    return cover_jpeg_decode(data, size, NULL);
}
static uint64_t now(void) { return (uint64_t)esp_timer_get_time() / 1000; }
static void expire(void *argument)
{
    (void)argument;
    if (!ready || xSemaphoreTake(mutex, 0) != pdTRUE) return;
    uint8_t status[24];
    cover_transfer_status(&state, status, now());
    if (!state.pending) owner = UINT16_MAX;
    xSemaphoreGive(mutex);
}
void cover_service_init(void)
{
    // UI 启动时单次初始化；不格式化任何已有分区。
    if (mutex) return;
    mutex = xSemaphoreCreateMutex();
    if (!mutex) return;
    const esp_partition_t *partition = esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA, 0x40, "cover");
    if (!partition || partition->size != 2 * COVER_BANK_BYTES) return;
    ready = cover_transfer_init(&state, (cover_io_t){
        .context = (void *)partition, .read = read_flash, .write = write_flash,
        .erase = erase_flash, .validate = validate});
    const esp_timer_create_args_t args = {.callback = expire, .name = "cover_timeout"};
    if (ready && esp_timer_create(&args, &timeout_timer) == ESP_OK)
        esp_timer_start_periodic(timeout_timer, 1000000);
}
bool cover_service_packet(uint16_t connection, const uint8_t *packet, size_t size)
{
    if (!ready) return false;
    xSemaphoreTake(mutex, portMAX_DELAY);
    uint8_t status[24];
    cover_transfer_status(&state, status, now());
    bool allowed = !state.pending || owner == connection;
    if (allowed) {
        cover_transfer_packet(&state, packet, size, now());
        owner = state.pending ? connection : UINT16_MAX;
    }
    xSemaphoreGive(mutex);
    return allowed;
}
void cover_service_status(uint8_t out[24])
{
    if (!ready) {
        memset(out, 0, 24);
        out[0] = 1;
        out[1] = COVER_STORAGE;
        return;
    }
    xSemaphoreTake(mutex, portMAX_DELAY);
    cover_transfer_status(&state, out, now());
    xSemaphoreGive(mutex);
}
void cover_service_disconnect(uint16_t connection)
{
    if (!ready) return;
    xSemaphoreTake(mutex, portMAX_DELAY);
    if (connection == UINT16_MAX || connection == owner) {
        if (state.pending) cover_transfer_abort(&state, COVER_CANCELLED);
        owner = UINT16_MAX;
    }
    xSemaphoreGive(mutex);
}
uint32_t cover_service_revision(void)
{
    if (!ready) return 0;
    xSemaphoreTake(mutex, portMAX_DELAY);
    uint32_t revision = state.revision;
    xSemaphoreGive(mutex);
    return revision;
}
bool cover_service_copy(uint8_t **data, size_t *size, uint32_t *revision)
{
    if (!ready || !data || !size || !revision) return false;
    xSemaphoreTake(mutex, portMAX_DELAY);
    *revision = state.revision;
    bool copied = cover_transfer_copy(&state, data, size);
    xSemaphoreGive(mutex);
    return copied;
}
