#include "services/exploration/bonus_game.h"
#include <assert.h>
#include <stdio.h>

int main(void)
{
    for (exploration_game_t game = GAME_GATE; game < GAME_COUNT; ++game) {
        bonus_round_t round = {0};
        assert(bonus_answer(game, &round, 0) == BONUS_INVALID);
        bonus_begin(&round);
        assert(bonus_answer(game, &round, 1) == BONUS_WRONG && round.stage == 0);
        for (uint8_t i = 0; i < bonus_total(game); ++i)
            assert(bonus_answer(game, &round, i) ==
                   (i + 1 == bonus_total(game) ? BONUS_COMPLETED : BONUS_ADVANCED));
        assert(bonus_answer(game, &round, 0) == BONUS_INVALID);
        assert(round.mistakes == 0);
        bonus_begin(&round);
        assert(round.stage == 0 && round.started);
    }
    bonus_round_t round = {0};
    bonus_begin(&round);
    for (unsigned i = 0; i < 300; ++i) bonus_answer(GAME_GATE, &round, 1);
    assert(round.mistakes == 255 && round.stage == 0);
    assert(bonus_answer(GAME_QIN, &round, 0) == BONUS_INVALID);
    puts("新增游戏顺序、重试、复玩与边界检查通过");
}
