#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef enum { GAME_QIN, GAME_GATE, GAME_POEM, GAME_COUNT } exploration_game_t;
typedef struct { uint8_t stage; uint8_t mistakes; bool started; } bonus_round_t;
typedef enum { BONUS_INVALID, BONUS_WRONG, BONUS_ADVANCED, BONUS_COMPLETED } bonus_result_t;

uint8_t bonus_total(exploration_game_t game);
void bonus_begin(bonus_round_t *round);
bonus_result_t bonus_answer(exploration_game_t game, bonus_round_t *round, uint8_t choice);
