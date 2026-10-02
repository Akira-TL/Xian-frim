#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool unlocked;
    bool completed;
    bool collected;
    bool exhibiting;
} qin_progress_t;

typedef struct {
    int8_t selected_piece;
    uint8_t placed_mask;
    uint8_t mistakes;
} qin_puzzle_t;

typedef enum {
    QIN_LOCKED,
    QIN_INVALID,
    QIN_WRONG,
    QIN_PLACED,
    QIN_COMPLETED,
    QIN_REPLAY_COMPLETED
} qin_result_t;

bool qin_progress_valid(const qin_progress_t *progress);
void qin_unlock(qin_progress_t *progress);
void qin_puzzle_begin(qin_puzzle_t *puzzle);
qin_result_t qin_select(const qin_progress_t *progress, qin_puzzle_t *puzzle, uint8_t piece);
qin_result_t qin_place(qin_progress_t *progress, qin_puzzle_t *puzzle, uint8_t slot);
bool qin_exhibit(qin_progress_t *progress);

#ifdef __cplusplus
}
#endif
