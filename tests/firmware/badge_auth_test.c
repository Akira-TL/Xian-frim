#include "services/exploration/badge_auth.h"
#include <assert.h>
#include <openssl/hmac.h>
#include <stdio.h>
#include <string.h>

static const uint8_t key[32] = {1};
static const uint8_t mac[6] = {0, 1, 2, 3, 4, 5};
static int executions;
static bool fail_save;
static uint8_t current_flags;

static bool digest(const uint8_t secret[32], const uint8_t *data, size_t length, uint8_t output[32])
{
    unsigned int size;
    return HMAC(EVP_sha256(), secret, 32, data, length, output, &size) != NULL && size == 32;
}

static bool operation(const char *command, uint8_t *flags, void *argument)
{
    (void)argument;
    if (command) {
        if (fail_save) return false;
        assert(strcmp(command, "unlock-1") == 0);
        executions++;
        current_flags |= 1;
    }
    *flags = current_flags;
    return true;
}

static void packet(uint8_t output[BADGE_UNLOCK_SIZE], const uint8_t nonce[16])
{
    memset(output, 0, BADGE_UNLOCK_SIZE);
    memcpy(output, "CU\1", 3);
    memcpy(output + 3, mac, 6);
    memcpy(output + 9, nonce, 16);
    memcpy(output + 25, "unlock-1", 8);
    memset(output + 89, 0xab, 16);
    assert(digest(key, output, 105, output + 105));
}

int main(void)
{
    badge_auth_t state = {0};
    uint8_t nonce[16] = {3};
    uint8_t message[BADGE_UNLOCK_SIZE];
    packet(message, nonce);
    assert(!badge_auth_handle(&state, message, sizeof(message), 0, mac, key, digest, operation, NULL));
    badge_auth_nonce(&state, nonce, 1000);
    message[136] ^= 1;
    assert(!badge_auth_handle(&state, message, sizeof(message), 1000, mac, key, digest, operation, NULL));
    assert(executions == 0);
    message[136] ^= 1;
    fail_save = true;
    assert(!badge_auth_handle(&state, message, sizeof(message), 1000, mac, key, digest, operation, NULL));
    assert(!state.has_reply && executions == 0);
    fail_save = false;
    assert(badge_auth_handle(&state, message, sizeof(message), 1000, mac, key, digest, operation, NULL));
    assert(executions == 1 && state.reply[25] == 1);
    uint8_t expected[32];
    assert(digest(key, state.reply, 90, expected));
    assert(memcmp(expected, state.reply + 90, 32) == 0);
    current_flags = 15;
    assert(badge_auth_handle(&state, message, sizeof(message), 2000, mac, key, digest, operation, NULL));
    assert(executions == 1 && state.reply[25] == 1); // 重试回原回执；通关另用新查询。
    message[89] ^= 1;
    assert(digest(key, message, 105, message + 105));
    assert(!badge_auth_handle(&state, message, sizeof(message), 2000, mac, key, digest, operation, NULL));
    assert(executions == 1);
    uint8_t query[19] = {'C', 'Q', 1};
    assert(badge_auth_handle(&state, query, sizeof(query), 2000, mac, key, digest, operation, NULL));
    assert(state.reply[25] == 15 && state.reply[26] == 0 && executions == 1);
    badge_auth_nonce(&state, nonce, 1000);
    packet(message, nonce);
    assert(!badge_auth_handle(&state, message, sizeof(message), 31000, mac, key, digest, operation, NULL));
    uint8_t new_nonce[16] = {4};
    badge_auth_nonce(&state, new_nonce, 32000);
    assert(!badge_auth_handle(&state, message, sizeof(message), 32000, mac, key, digest, operation, NULL));
    // 合法认证码仍不能跨设备，长度和填充不正确也不能触发执行。
    packet(message, new_nonce);
    message[3] ^= 1;
    assert(digest(key, message, 105, message + 105));
    assert(!badge_auth_handle(&state, message, sizeof(message), 32000, mac, key, digest, operation, NULL));
    assert(!badge_auth_handle(&state, message, 0, 32000, mac, key, digest, operation, NULL));
    packet(message, new_nonce);
    message[88] = 'X';
    assert(digest(key, message, 105, message + 105));
    assert(!badge_auth_handle(&state, message, sizeof(message), 32000, mac, key, digest, operation, NULL));
    puts("腰牌认证：身份、认证码、过期、单次随机数、持久化失败、查询及重试通过");
    return 0;
}
