#include "bonus_game.h"
#include <stddef.h>

uint8_t bonus_total(exploration_game_t game)
{
    return game == GAME_GATE ? 3 : game == GAME_POEM ? 2 : 0;
}

void bonus_begin(bonus_round_t *round)
{
    if (round) *round = (bonus_round_t){.started = true};
}

bonus_result_t bonus_answer(exploration_game_t game, bonus_round_t *round, uint8_t choice)
{
    uint8_t total = bonus_total(game);
    if (!round || !round->started || !total || round->stage >= total ||
        choice >= (game == GAME_GATE ? 3 : 2)) return BONUS_INVALID;
    // 城门：门、旗、鼓；诗句：第一题选项0，第二题选项1。
    uint8_t expected = round->stage;
    if (choice != expected) {
        if (round->mistakes < UINT8_MAX) ++round->mistakes;
        return BONUS_WRONG;
    }
    ++round->stage;
    round->mistakes = 0;
    return round->stage == total ? BONUS_COMPLETED : BONUS_ADVANCED;
}
