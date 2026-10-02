#include "qin_game.h"

bool qin_progress_valid(const qin_progress_t *progress)
{
    return progress && (!progress->completed || progress->unlocked) &&
           progress->collected == progress->completed &&
           (!progress->exhibiting || progress->collected);
}

void qin_unlock(qin_progress_t *progress)
{
    progress->unlocked = true;
}

void qin_puzzle_begin(qin_puzzle_t *puzzle)
{
    *puzzle = (qin_puzzle_t){.selected_piece = -1};
}

qin_result_t qin_select(const qin_progress_t *progress, qin_puzzle_t *puzzle, uint8_t piece)
{
    if (!progress->unlocked) return QIN_LOCKED;
    if (piece >= 3 || (puzzle->placed_mask & (1u << piece))) return QIN_INVALID;
    puzzle->selected_piece = (int8_t)piece;
    return QIN_PLACED;
}

qin_result_t qin_place(qin_progress_t *progress, qin_puzzle_t *puzzle, uint8_t slot)
{
    if (!progress->unlocked) return QIN_LOCKED;
    if (slot >= 3 || puzzle->selected_piece < 0 ||
        (puzzle->placed_mask & (1u << slot))) return QIN_INVALID;
    if (slot != (uint8_t)puzzle->selected_piece) {
        if (puzzle->mistakes < UINT8_MAX) ++puzzle->mistakes;
        puzzle->selected_piece = -1;
        return QIN_WRONG;
    }
    puzzle->placed_mask |= (uint8_t)(1u << slot);
    puzzle->selected_piece = -1;
    puzzle->mistakes = 0;
    if (puzzle->placed_mask != 7) return QIN_PLACED;
    if (progress->completed) return QIN_REPLAY_COMPLETED;
    progress->completed = true;
    progress->collected = true;
    return QIN_COMPLETED;
}

bool qin_exhibit(qin_progress_t *progress)
{
    if (!progress->collected) return false;
    progress->exhibiting = true;
    return true;
}
