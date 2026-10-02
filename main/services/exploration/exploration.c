#include "exploration.h"

#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "nvs.h"

// 单个 NVS blob 保存活动与奖励，避免多键更新导致部分完成。
typedef struct {
    uint8_t schema;
    uint8_t flags;
    char session[EXPLORATION_SESSION_SIZE];
    char command[EXPLORATION_COMMAND_SIZE];
} saved_progress_t;

static SemaphoreHandle_t mutex;
static nvs_handle_t storage;
static bool ready;
static saved_progress_t saved;
static qin_progress_t progress;
static qin_puzzle_t puzzle;

static uint8_t encode_flags(const qin_progress_t *value)
{
    return value->unlocked | (value->completed << 1) |
           (value->collected << 2) | (value->exhibiting << 3);
}

static qin_progress_t decode_flags(uint8_t flags)
{
    return (qin_progress_t){
        .unlocked = (flags & 1) != 0, .completed = (flags & 2) != 0,
        .collected = (flags & 4) != 0, .exhibiting = (flags & 8) != 0};
}

static esp_err_t persist(const saved_progress_t *next)
{
    esp_err_t error = nvs_set_blob(storage, "progress", next, sizeof(*next));
    return error == ESP_OK ? nvs_commit(storage) : error;
}

esp_err_t exploration_init(void)
{
    // 在 ui_init 单次调用，远程入口只在 ready 后接受操作。
    if (ready) return ESP_OK;
    if (!mutex) mutex = xSemaphoreCreateMutex();
    if (!mutex) return ESP_ERR_NO_MEM;
    esp_err_t error = nvs_open("exploration", NVS_READWRITE, &storage);
    if (error != ESP_OK) return error;
    size_t length = sizeof(saved);
    error = nvs_get_blob(storage, "progress", &saved, &length);
    if (error == ESP_ERR_NVS_NOT_FOUND) {
        saved = (saved_progress_t){.schema = 1, .session = "demo-001"};
        error = persist(&saved);
    } else if (error == ESP_OK) {
        progress = decode_flags(saved.flags);
        if (length != sizeof(saved) || saved.schema != 1 || saved.flags > 15 ||
            !memchr(saved.session, 0, sizeof(saved.session)) || !saved.session[0] ||
            !memchr(saved.command, 0, sizeof(saved.command)) ||
            !qin_progress_valid(&progress)) error = ESP_ERR_INVALID_STATE;
    }
    if (error != ESP_OK) {
        nvs_close(storage);
        return error;
    }
    progress = decode_flags(saved.flags);
    qin_puzzle_begin(&puzzle);
    ready = true;
    return ESP_OK;
}

esp_err_t exploration_get(qin_progress_t *out_progress, qin_puzzle_t *out_puzzle,
                          char session[EXPLORATION_SESSION_SIZE])
{
    if (!ready) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(mutex, portMAX_DELAY);
    if (out_progress) *out_progress = progress;
    if (out_puzzle) *out_puzzle = puzzle;
    if (session) memcpy(session, saved.session, sizeof(saved.session));
    xSemaphoreGive(mutex);
    return ESP_OK;
}

esp_err_t exploration_unlock(const char *session, const char *command)
{
    if (!session || !command || !command[0] ||
        strnlen(command, EXPLORATION_COMMAND_SIZE) >= EXPLORATION_COMMAND_SIZE)
        return ESP_ERR_INVALID_ARG;
    if (!ready) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(mutex, portMAX_DELAY);
    esp_err_t error = ESP_OK;
    if (strcmp(session, saved.session) != 0) {
        error = ESP_ERR_INVALID_ARG;
    } else if (!progress.unlocked) {
        saved_progress_t next = saved;
        qin_progress_t next_progress = progress;
        qin_unlock(&next_progress);
        next.flags = encode_flags(&next_progress);
        strcpy(next.command, command);
        error = persist(&next);
        if (error == ESP_OK) {
            saved = next;
            progress = next_progress;
        }
    }
    xSemaphoreGive(mutex);
    return error;
}

esp_err_t exploration_begin(void)
{
    if (!ready) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(mutex, portMAX_DELAY);
    esp_err_t error = progress.unlocked ? ESP_OK : ESP_ERR_INVALID_STATE;
    if (error == ESP_OK) qin_puzzle_begin(&puzzle);
    xSemaphoreGive(mutex);
    return error;
}

esp_err_t exploration_select(uint8_t piece, qin_result_t *result)
{
    if (!result) return ESP_ERR_INVALID_ARG;
    if (!ready) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(mutex, portMAX_DELAY);
    *result = qin_select(&progress, &puzzle, piece);
    xSemaphoreGive(mutex);
    return ESP_OK;
}

esp_err_t exploration_place(uint8_t slot, qin_result_t *result)
{
    if (!result) return ESP_ERR_INVALID_ARG;
    if (!ready) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(mutex, portMAX_DELAY);
    qin_progress_t next_progress = progress;
    qin_puzzle_t next_puzzle = puzzle;
    *result = qin_place(&next_progress, &next_puzzle, slot);
    esp_err_t error = ESP_OK;
    if (*result == QIN_COMPLETED) {
        saved_progress_t next = saved;
        next.flags = encode_flags(&next_progress);
        error = persist(&next);
        if (error == ESP_OK) saved = next;
    }
    if (error == ESP_OK) {
        progress = next_progress;
        puzzle = next_puzzle;
    }
    xSemaphoreGive(mutex);
    return error;
}

esp_err_t exploration_exhibit(void)
{
    if (!ready) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(mutex, portMAX_DELAY);
    qin_progress_t next_progress = progress;
    esp_err_t error = ESP_ERR_INVALID_STATE;
    if (qin_exhibit(&next_progress)) {
        saved_progress_t next = saved;
        next.flags = encode_flags(&next_progress);
        error = next.flags == saved.flags ? ESP_OK : persist(&next);
        if (error == ESP_OK) {
            saved = next;
            progress = next_progress;
        }
    }
    xSemaphoreGive(mutex);
    return error;
}
