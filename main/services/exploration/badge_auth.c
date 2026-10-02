#include "badge_auth.h"
#include <string.h>

static bool equal_secret(const uint8_t *left, const uint8_t *right, size_t length)
{
    uint8_t difference = 0;
    for (size_t i = 0; i < length; ++i) difference |= left[i] ^ right[i];
    return difference == 0;
}

void badge_auth_nonce(badge_auth_t *state, const uint8_t nonce[16], uint64_t now_ms)
{
    memcpy(state->nonce, nonce, 16);
    state->expires_ms = now_ms > UINT64_MAX - 30000 ? UINT64_MAX : now_ms + 30000;
    state->nonce_valid = true;
    state->has_last = false;
    state->has_reply = false;
}

static bool valid_command(const uint8_t command[64])
{
    size_t end = 0;
    while (end < 64 && command[end]) {
        uint8_t c = command[end++];
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
              (c >= '0' && c <= '9') || c == '_' || c == '-')) return false;
    }
    if (end == 0 || end == 64) return false;
    for (; end < 64; ++end) if (command[end]) return false;
    return true;
}

bool badge_auth_handle(badge_auth_t *state, const uint8_t *packet, size_t length,
                       uint64_t now_ms, const uint8_t mac[6], const uint8_t key[32],
                       badge_hmac_fn hmac, badge_operation_fn operation, void *argument)
{
    state->has_reply = false;
    bool unlock = length == BADGE_UNLOCK_SIZE && memcmp(packet, "CU\1", 3) == 0;
    bool query = length == 19 && memcmp(packet, "CQ\1", 3) == 0;
    if (!unlock && !query) return false;
    if (unlock && state->has_last && now_ms < state->expires_ms &&
        memcmp(packet, state->last_packet, BADGE_UNLOCK_SIZE) == 0) {
        memcpy(state->reply, state->last_reply, BADGE_REPLY_SIZE);
        state->has_reply = true;
        return true;
    }
    uint8_t digest[32];
    if (unlock && (!state->nonce_valid || now_ms >= state->expires_ms ||
                   !equal_secret(packet + 3, mac, 6) ||
                   !equal_secret(packet + 9, state->nonce, 16) ||
                   !valid_command(packet + 25) ||
                   !hmac(key, packet, 105, digest) ||
                   !equal_secret(digest, packet + 105, 32))) return false;
    uint8_t flags;
    if (!operation(unlock ? (const char *)(packet + 25) : NULL, &flags, argument)) return false;
    if ((flags != 0 && flags != 1 && flags != 7 && flags != 15) || (unlock && !(flags & 1))) return false;
    uint8_t reply[BADGE_REPLY_SIZE] = {0};
    memcpy(reply, "CS\1", 3);
    memcpy(reply + 3, mac, 6);
    memcpy(reply + 9, unlock ? packet + 89 : packet + 3, 16);
    reply[25] = flags;
    if (unlock) memcpy(reply + 26, packet + 25, 64);
    if (!hmac(key, reply, 90, reply + 90)) return false;
    memcpy(state->reply, reply, BADGE_REPLY_SIZE);
    state->has_reply = true;
    if (unlock) {
        state->nonce_valid = false;
        state->has_last = true;
        memcpy(state->last_packet, packet, BADGE_UNLOCK_SIZE);
        memcpy(state->last_reply, reply, BADGE_REPLY_SIZE);
    }
    return true;
}
