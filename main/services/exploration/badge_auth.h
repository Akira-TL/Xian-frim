#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define BADGE_UNLOCK_SIZE 137
#define BADGE_REPLY_SIZE 122

typedef bool (*badge_hmac_fn)(const uint8_t key[32], const uint8_t *data,
                              size_t length, uint8_t digest[32]);
// command 为 NULL 时只读取；非 NULL 时先完成持久化解锁再返回真实标志。
typedef bool (*badge_operation_fn)(const char *command, uint8_t *flags, void *argument);

typedef struct {
    uint8_t nonce[16];
    uint64_t expires_ms;
    bool nonce_valid;
    bool has_last;
    bool has_reply;
    uint8_t last_packet[BADGE_UNLOCK_SIZE];
    uint8_t last_reply[BADGE_REPLY_SIZE];
    uint8_t reply[BADGE_REPLY_SIZE];
} badge_auth_t;

void badge_auth_nonce(badge_auth_t *state, const uint8_t nonce[16], uint64_t now_ms);
bool badge_auth_handle(badge_auth_t *state, const uint8_t *packet, size_t length,
                       uint64_t now_ms, const uint8_t mac[6], const uint8_t key[32],
                       badge_hmac_fn hmac, badge_operation_fn operation, void *argument);
