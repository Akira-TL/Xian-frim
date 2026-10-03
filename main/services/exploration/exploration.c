#include "exploration.h"

#include <string.h>
#include <stdatomic.h>
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
// 初始化来自界面任务，远程读取来自蓝牙任务，发布时同步初始化后的状态。
static atomic_bool ready;
static saved_progress_t saved;
static qin_progress_t progress;
static qin_puzzle_t puzzle;
static exploration_screen_t screen = EXPLORATION_COVER;
static exploration_game_t game;
static bonus_round_t rounds[2];
typedef struct { uint8_t schema, collected, exhibit; } saved_bonus_t;
static saved_bonus_t bonus = {.schema = 1, .exhibit = GAME_COUNT};

static esp_err_t persist_bonus(const saved_bonus_t *next)
{
    esp_err_t error = nvs_set_blob(storage, "bonus", next, sizeof(*next));
    return error == ESP_OK ? nvs_commit(storage) : error;
}

esp_err_t exploration_set_game(exploration_game_t value)
{
    if (value < GAME_QIN || value >= GAME_COUNT) return ESP_ERR_INVALID_ARG;
    if (!ready) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(mutex, portMAX_DELAY);
    game = value;
    xSemaphoreGive(mutex);
    return ESP_OK;
}

esp_err_t exploration_bonus_begin(exploration_game_t value)
{
    if (!bonus_total(value)) return ESP_ERR_INVALID_ARG;
    if (!ready) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(mutex, portMAX_DELAY);
    bonus_begin(&rounds[value - 1]);
    xSemaphoreGive(mutex);
    return ESP_OK;
}

esp_err_t exploration_bonus_answer(exploration_game_t value, uint8_t choice, bonus_result_t *result)
{
    if (!result || !bonus_total(value)) return ESP_ERR_INVALID_ARG;
    if (!ready) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(mutex, portMAX_DELAY);
    bonus_round_t next_round = rounds[value - 1];
    *result = bonus_answer(value, &next_round, choice);
    saved_bonus_t next = bonus;
    esp_err_t error = ESP_OK;
    if (*result == BONUS_COMPLETED) {
        next.collected |= 1u << (value - 1);
        if (next.collected != bonus.collected) error = persist_bonus(&next);
    }
    if (error == ESP_OK) {
        rounds[value - 1] = next_round;
        bonus = next;
    }
    xSemaphoreGive(mutex);
    return error;
}

esp_err_t exploration_display_game(exploration_game_t value)
{
    if (value < GAME_QIN || value >= GAME_COUNT) return ESP_ERR_INVALID_ARG;
    if (!ready) return ESP_ERR_INVALID_STATE;
    // 秦俑展示仍走既有持久化认证链路；新增本地奖励不改变该链路。
    if (value == GAME_QIN) {
        esp_err_t error = exploration_exhibit();
        if (error != ESP_OK) return error;
    }
    xSemaphoreTake(mutex, portMAX_DELAY);
    esp_err_t error = ESP_ERR_INVALID_STATE;
    if (value == GAME_QIN || (bonus.collected & (1u << (value - 1)))) {
        saved_bonus_t next = bonus;
        next.exhibit = value;
        error = next.exhibit == bonus.exhibit ? ESP_OK : persist_bonus(&next);
        if (error == ESP_OK) bonus = next;
    }
    xSemaphoreGive(mutex);
    return error;
}

esp_err_t exploration_set_screen(exploration_screen_t value)
{
    if (value < 0 || value >= EXPLORATION_SCREEN_COUNT) return ESP_ERR_INVALID_ARG;
    if (!ready) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(mutex, portMAX_DELAY);
    screen = value;
    xSemaphoreGive(mutex);
    return ESP_OK;
}

esp_err_t exploration_snapshot(exploration_snapshot_t *snapshot)
{
    if (!snapshot) return ESP_ERR_INVALID_ARG;
    if (!ready) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(mutex, portMAX_DELAY);
    *snapshot = (exploration_snapshot_t){.progress = progress, .puzzle = puzzle, .screen = screen};
    snapshot->game = game;
    memcpy(snapshot->rounds, rounds, sizeof(rounds));
    snapshot->bonus_collected = bonus.collected;
    snapshot->exhibit_game = bonus.exhibit;
    xSemaphoreGive(mutex);
    return ESP_OK;
}

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
    length = sizeof(bonus);
    error = nvs_get_blob(storage, "bonus", &bonus, &length);
    if (error == ESP_ERR_NVS_NOT_FOUND) {
        bonus = (saved_bonus_t){.schema = 1, .exhibit = progress.exhibiting ? GAME_QIN : GAME_COUNT};
        error = persist_bonus(&bonus);
    } else if (error == ESP_OK && (length != sizeof(bonus) || bonus.schema != 1 ||
               bonus.collected > 3 || bonus.exhibit > GAME_COUNT ||
               (bonus.exhibit == GAME_QIN && !progress.collected) ||
               (bonus.exhibit > GAME_QIN && bonus.exhibit < GAME_COUNT &&
                !(bonus.collected & (1u << (bonus.exhibit - 1)))))) {
        error = ESP_ERR_INVALID_STATE;
    }
    if (error != ESP_OK) { nvs_close(storage); return error; }
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
