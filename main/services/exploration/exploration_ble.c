#include "exploration_ble.h"
#include "exploration.h"
#include "badge_auth.h"
#include "services/cover/cover_service.h"
#include "services/cover/cover_transfer.h"

#include <stdio.h>
#include <string.h>
#include "doit_ble.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "host/ble_hs.h"
#include "mbedtls/md.h"

#if __has_include("changan_device_key.h")
#include "changan_device_key.h"
#else
// 未配置时仍提供身份读取，但禁止任何认证操作；不使用默认密钥。
static const uint8_t changan_device_key[32] = {0};
static const uint8_t changan_device_mac[6] = {0};
#define CHANGAN_DEVICE_KEY_CONFIGURED 0
#endif

static const ble_uuid128_t service_uuid = BLE_UUID128_INIT(
    0x4f, 0x97, 0xb3, 0x02, 0xce, 0x78, 0xf1, 0xb1,
    0x10, 0x4a, 0xaa, 0x64, 0x01, 0x40, 0x99, 0x5e);
static const ble_uuid128_t identity_uuid = BLE_UUID128_INIT(
    0x4f, 0x97, 0xb3, 0x02, 0xce, 0x78, 0xf1, 0xb1,
    0x10, 0x4a, 0xaa, 0x64, 0x02, 0x40, 0x99, 0x5e);
static const ble_uuid128_t state_uuid = BLE_UUID128_INIT(
    0x4f, 0x97, 0xb3, 0x02, 0xce, 0x78, 0xf1, 0xb1,
    0x10, 0x4a, 0xaa, 0x64, 0x03, 0x40, 0x99, 0x5e);
static const ble_uuid128_t nonce_uuid = BLE_UUID128_INIT(
    0x4f, 0x97, 0xb3, 0x02, 0xce, 0x78, 0xf1, 0xb1,
    0x10, 0x4a, 0xaa, 0x64, 0x04, 0x40, 0x99, 0x5e);
static const ble_uuid128_t control_uuid = BLE_UUID128_INIT(
    0x4f, 0x97, 0xb3, 0x02, 0xce, 0x78, 0xf1, 0xb1,
    0x10, 0x4a, 0xaa, 0x64, 0x05, 0x40, 0x99, 0x5e);
static const ble_uuid128_t reply_uuid = BLE_UUID128_INIT(
    0x4f, 0x97, 0xb3, 0x02, 0xce, 0x78, 0xf1, 0xb1,
    0x10, 0x4a, 0xaa, 0x64, 0x06, 0x40, 0x99, 0x5e);
static const ble_uuid128_t cover_uuid = BLE_UUID128_INIT(
    0x4f, 0x97, 0xb3, 0x02, 0xce, 0x78, 0xf1, 0xb1,
    0x10, 0x4a, 0xaa, 0x64, 0x07, 0x40, 0x99, 0x5e);

typedef struct {
    bool active;
    uint16_t connection;
    badge_auth_t auth;
} auth_connection_t;

// 访问与断开回调均在 NimBLE 主任务执行；游戏状态由 exploration 的互斥锁保护。
static auth_connection_t connections[CONFIG_BT_NIMBLE_MAX_CONNECTIONS];

static void disconnected(uint16_t connection)
{
    cover_service_disconnect(connection);
    for (size_t i = 0; i < CONFIG_BT_NIMBLE_MAX_CONNECTIONS; ++i) {
        if (connection == UINT16_MAX || connections[i].connection == connection)
            memset(&connections[i], 0, sizeof(connections[i]));
    }
}

static badge_auth_t *connection_state(uint16_t connection)
{
    struct ble_gap_conn_desc descriptor;
    if (ble_gap_conn_find(connection, &descriptor) != 0) return NULL;
    auth_connection_t *available = NULL;
    for (size_t i = 0; i < CONFIG_BT_NIMBLE_MAX_CONNECTIONS; ++i) {
        if (connections[i].active && connections[i].connection == connection)
            return &connections[i].auth;
        if (!connections[i].active) available = &connections[i];
    }
    if (!available) return NULL;
    *available = (auth_connection_t){.active = true, .connection = connection};
    return &available->auth;
}

static bool authenticate(const uint8_t key[32], const uint8_t *data,
                         size_t length, uint8_t digest[32])
{
    const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    return info && mbedtls_md_hmac(info, key, 32, data, length, digest) == 0;
}

static bool operate(const char *command, uint8_t *flags, void *argument)
{
    (void)argument;
    if (command && exploration_unlock("demo-001", command) != ESP_OK) return false;
    qin_progress_t progress;
    char session[EXPLORATION_SESSION_SIZE];
    if (exploration_get(&progress, NULL, session) != ESP_OK || strcmp(session, "demo-001") != 0)
        return false;
    *flags = progress.unlocked | (progress.completed << 1) |
             (progress.collected << 2) | (progress.exhibiting << 3);
    return true;
}

typedef enum {AUTH_NONCE, AUTH_CONTROL, AUTH_REPLY} auth_attribute_t;

static int access_auth(uint16_t connection, uint16_t handle,
                       struct ble_gatt_access_ctxt *context, void *argument)
{
    (void)handle;
    if (!CHANGAN_DEVICE_KEY_CONFIGURED) return BLE_ATT_ERR_INSUFFICIENT_AUTHEN;
    // 比赛演示编号随烧录包携带，不绑定目标芯片出厂地址。
    // 仍验证消息签名、随机数与保存结果；同包设备不是独立的真实到访身份。
    const uint8_t *mac = changan_device_mac;
    badge_auth_t *state = connection_state(connection);
    if (!state) return BLE_ATT_ERR_INSUFFICIENT_RES;
    auth_attribute_t attribute = (auth_attribute_t)(intptr_t)argument;
    uint64_t now_ms = (uint64_t)esp_timer_get_time() / 1000;
    if (attribute == AUTH_CONTROL) {
        if (context->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
        size_t length = OS_MBUF_PKTLEN(context->om);
        if (length != BADGE_UNLOCK_SIZE && length != 19) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        uint8_t packet[BADGE_UNLOCK_SIZE];
        if (os_mbuf_copydata(context->om, 0, length, packet) != 0) return BLE_ATT_ERR_UNLIKELY;
        return badge_auth_handle(state, packet, length, now_ms, mac, changan_device_key,
                                 authenticate, operate, NULL) ? 0 : BLE_ATT_ERR_UNLIKELY;
    }
    if (context->op != BLE_GATT_ACCESS_OP_READ_CHR) return BLE_ATT_ERR_READ_NOT_PERMITTED;
    if (attribute == AUTH_NONCE) {
        uint8_t nonce[16];
        // 此回调仅在蓝牙控制器运行时调用，使用 ESP-IDF 硬件随机数源。
        esp_fill_random(nonce, sizeof(nonce));
        badge_auth_nonce(state, nonce, now_ms);
        return os_mbuf_append(context->om, nonce, sizeof(nonce)) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    if (!state->has_reply) return BLE_ATT_ERR_UNLIKELY;
    return os_mbuf_append(context->om, state->reply, BADGE_REPLY_SIZE) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static int read_value(uint16_t connection, uint16_t handle,
                      struct ble_gatt_access_ctxt *context, void *argument)
{
    (void)connection;
    (void)handle;
    if (context->op != BLE_GATT_ACCESS_OP_READ_CHR) return BLE_ATT_ERR_READ_NOT_PERMITTED;
    uint8_t mac[6];
    if (CHANGAN_DEVICE_KEY_CONFIGURED) memcpy(mac, changan_device_mac, sizeof(mac));
    else if (esp_read_mac(mac, ESP_MAC_WIFI_STA) != ESP_OK) return BLE_ATT_ERR_UNLIKELY;
    char device[32];
    snprintf(device, sizeof(device), "esp32s3-%02x%02x%02x%02x%02x%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    if (argument == NULL) {
        return os_mbuf_append(context->om, device, strlen(device)) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    exploration_snapshot_t snapshot;
    char session[EXPLORATION_SESSION_SIZE];
    if (exploration_get(NULL, NULL, session) != ESP_OK || strcmp(session, "demo-001") != 0)
        return BLE_ATT_ERR_UNLIKELY;
    if (exploration_snapshot(&snapshot) != ESP_OK) return BLE_ATT_ERR_UNLIKELY;
    qin_progress_t progress = snapshot.progress;
    static const char *const screens[] = {"cover", "selection", "intro", "playing", "result",
                                         "collection", "exhibit", "settings"};
    if (snapshot.screen >= EXPLORATION_SCREEN_COUNT) return BLE_ATT_ERR_UNLIKELY;
    // 实时遥测不替代签名进度，不改变既有版本1认证回执。
    char state[512];
    static const char *const games[] = {"qin_formation", "gate_search", "poem_completion"};
    if (snapshot.game >= GAME_COUNT) return BLE_ATT_ERR_UNLIKELY;
    unsigned stage = snapshot.game == GAME_QIN ? 0 : snapshot.rounds[snapshot.game - 1].stage;
    int length = snprintf(state, sizeof(state),
        "{\"v\":2,\"device_id\":\"%s\",\"session_id\":\"demo-001\","
        "\"game_id\":\"%s\",\"unlocked\":%s,\"completed\":%s,\"collected\":%s,\"exhibiting\":%s,"
        "\"screen\":\"%s\",\"placed_mask\":%u,\"mistakes\":%u,"
        "\"stage\":%u,\"bonus_collected\":%u,\"exhibit_game\":%u}",
        device, games[snapshot.game], progress.unlocked ? "true" : "false", progress.completed ? "true" : "false",
        progress.collected ? "true" : "false", progress.exhibiting ? "true" : "false",
        screens[snapshot.screen], snapshot.puzzle.placed_mask, snapshot.puzzle.mistakes,
        stage, snapshot.bonus_collected, snapshot.exhibit_game);
    if (length < 0 || length >= sizeof(state)) return BLE_ATT_ERR_INSUFFICIENT_RES;
    return os_mbuf_append(context->om, state, length) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static int access_cover(uint16_t connection, uint16_t handle,
                        struct ble_gatt_access_ctxt *context, void *argument)
{
    (void)handle;
    (void)argument;
    if (context->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        uint8_t status[24];
        cover_service_status(status);
        return os_mbuf_append(context->om, status, sizeof(status)) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    if (context->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
    size_t size = OS_MBUF_PKTLEN(context->om);
    uint8_t packet[11 + COVER_CHUNK_BYTES];
    if (size < 7 || size > sizeof(packet)) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    if (os_mbuf_copydata(context->om, 0, size, packet) != 0) return BLE_ATT_ERR_UNLIKELY;
    return cover_service_packet(connection, packet, size) ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static const struct ble_gatt_svc_def services[] = {
    {.type = BLE_GATT_SVC_TYPE_PRIMARY, .uuid = &service_uuid.u,
     .characteristics = (struct ble_gatt_chr_def[]){
         {.uuid = &identity_uuid.u, .access_cb = read_value, .flags = BLE_GATT_CHR_F_READ},
         {.uuid = &state_uuid.u, .access_cb = read_value, .flags = BLE_GATT_CHR_F_READ, .arg = (void *)1},
         {.uuid = &nonce_uuid.u, .access_cb = access_auth, .flags = BLE_GATT_CHR_F_READ, .arg = (void *)AUTH_NONCE},
         {.uuid = &control_uuid.u, .access_cb = access_auth, .flags = BLE_GATT_CHR_F_WRITE, .arg = (void *)AUTH_CONTROL},
         {.uuid = &reply_uuid.u, .access_cb = access_auth, .flags = BLE_GATT_CHR_F_READ, .arg = (void *)AUTH_REPLY},
         {.uuid = &cover_uuid.u, .access_cb = access_cover, .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE},
         {0}}},
    {0}};

static int register_services(void)
{
    disconnected(UINT16_MAX);
    int result = ble_gatts_count_cfg(services);
    return result == 0 ? ble_gatts_add_svcs(services) : result;
}

void exploration_ble_register(void)
{
    doit_ble_gatt_cb_register(register_services);
    doit_ble_disconnect_cb_register(disconnected);
}
