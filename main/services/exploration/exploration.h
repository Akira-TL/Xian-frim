#pragma once

#include "qin_game.h"
#include "bonus_game.h"
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define EXPLORATION_SESSION_SIZE 48
#define EXPLORATION_COMMAND_SIZE 64

typedef enum {
    EXPLORATION_COVER, EXPLORATION_SELECTION, EXPLORATION_INTRO,
    EXPLORATION_PLAYING, EXPLORATION_RESULT, EXPLORATION_COLLECTION,
    EXPLORATION_EXHIBIT, EXPLORATION_SETTINGS, EXPLORATION_SCREEN_COUNT
} exploration_screen_t;

typedef struct {
    qin_progress_t progress;
    qin_puzzle_t puzzle;
    exploration_screen_t screen;
    exploration_game_t game;
    bonus_round_t rounds[2];
    uint8_t bonus_collected;
    uint8_t exhibit_game; // GAME_COUNT 表示尚未设置展示。
} exploration_snapshot_t;

// 界面信息仅为当前会话遥测；不修改持久化进度或认证消息。
esp_err_t exploration_set_screen(exploration_screen_t screen);
esp_err_t exploration_snapshot(exploration_snapshot_t *snapshot);
esp_err_t exploration_set_game(exploration_game_t game);
esp_err_t exploration_bonus_begin(exploration_game_t game);
esp_err_t exploration_bonus_answer(exploration_game_t game, uint8_t choice, bonus_result_t *result);
esp_err_t exploration_display_game(exploration_game_t game);

esp_err_t exploration_init(void);
esp_err_t exploration_get(qin_progress_t *progress, qin_puzzle_t *puzzle,
                          char session[EXPLORATION_SESSION_SIZE]);
esp_err_t exploration_unlock(const char *session, const char *command);
esp_err_t exploration_begin(void);
esp_err_t exploration_select(uint8_t piece, qin_result_t *result);
esp_err_t exploration_place(uint8_t slot, qin_result_t *result);
esp_err_t exploration_exhibit(void);

#ifdef __cplusplus
}
#endif
