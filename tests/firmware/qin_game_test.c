#include "services/exploration/qin_game.h"
#include <assert.h>
#include <stdio.h>

static void solve(qin_progress_t *progress, qin_puzzle_t *puzzle, qin_result_t expected)
{
    const uint8_t order[] = {2, 0, 1};
    for (unsigned i = 0; i < 3; ++i) {
        assert(qin_select(progress, puzzle, order[i]) == QIN_PLACED);
        assert(qin_place(progress, puzzle, order[i]) == (i == 2 ? expected : QIN_PLACED));
    }
}

int main(void)
{
    qin_progress_t progress = {0};
    qin_puzzle_t puzzle;
    qin_puzzle_begin(&puzzle);
    assert(qin_progress_valid(&progress));
    assert(qin_select(&progress, &puzzle, 0) == QIN_PLACED);
    assert(qin_place(&progress, &puzzle, 0) == QIN_PLACED);
    assert(progress.unlocked && !progress.collected);
    qin_puzzle_begin(&puzzle);
    assert(!qin_exhibit(&progress));
    qin_unlock(&progress);
    assert(qin_select(&progress, &puzzle, 3) == QIN_INVALID);
    assert(qin_place(&progress, &puzzle, 0) == QIN_INVALID);
    for (unsigned i = 0; i < 2; ++i) {
        assert(qin_select(&progress, &puzzle, 2) == QIN_PLACED);
        assert(qin_place(&progress, &puzzle, 0) == QIN_WRONG);
    }
    assert(puzzle.mistakes == 2);
    assert(!progress.completed && !progress.collected);
    solve(&progress, &puzzle, QIN_COMPLETED);
    assert(progress.completed && progress.collected);
    assert(qin_progress_valid(&progress));
    assert(qin_exhibit(&progress));
    qin_unlock(&progress);
    qin_puzzle_begin(&puzzle);
    solve(&progress, &puzzle, QIN_REPLAY_COMPLETED);
    assert(progress.exhibiting);
    assert(qin_place(&progress, &puzzle, 1) == QIN_INVALID);
    qin_progress_t corrupt = {.completed = true, .collected = true};
    assert(!qin_progress_valid(&corrupt));
    puts("秦俑游戏：无需解锁直接游玩、错误恢复、三片通关、收藏、复玩测试通过");
    return 0;
}
