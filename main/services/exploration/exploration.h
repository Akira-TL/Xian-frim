#pragma once

#include "qin_game.h"
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define EXPLORATION_SESSION_SIZE 48
#define EXPLORATION_COMMAND_SIZE 64

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
