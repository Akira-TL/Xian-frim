#include "exploration_ble.h"
#include "exploration.h"

#include <stdio.h>
#include <string.h>
#include "doit_ble.h"
#include "esp_mac.h"
#include "host/ble_hs.h"

static const ble_uuid128_t service_uuid = BLE_UUID128_INIT(
    0x4f, 0x97, 0xb3, 0x02, 0xce, 0x78, 0xf1, 0xb1,
    0x10, 0x4a, 0xaa, 0x64, 0x01, 0x40, 0x99, 0x5e);
static const ble_uuid128_t identity_uuid = BLE_UUID128_INIT(
    0x4f, 0x97, 0xb3, 0x02, 0xce, 0x78, 0xf1, 0xb1,
    0x10, 0x4a, 0xaa, 0x64, 0x02, 0x40, 0x99, 0x5e);
static const ble_uuid128_t state_uuid = BLE_UUID128_INIT(
    0x4f, 0x97, 0xb3, 0x02, 0xce, 0x78, 0xf1, 0xb1,
    0x10, 0x4a, 0xaa, 0x64, 0x03, 0x40, 0x99, 0x5e);

static int read_value(uint16_t connection, uint16_t handle,
                      struct ble_gatt_access_ctxt *context, void *argument)
{
    (void)connection;
    (void)handle;
    if (context->op != BLE_GATT_ACCESS_OP_READ_CHR) return BLE_ATT_ERR_READ_NOT_PERMITTED;
    uint8_t mac[6];
    if (esp_read_mac(mac, ESP_MAC_WIFI_STA) != ESP_OK) return BLE_ATT_ERR_UNLIKELY;
    char device[32];
    snprintf(device, sizeof(device), "esp32s3-%02x%02x%02x%02x%02x%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    if (argument == NULL) {
        return os_mbuf_append(context->om, device, strlen(device)) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    qin_progress_t progress;
    char session[EXPLORATION_SESSION_SIZE];
    if (exploration_get(&progress, NULL, session) != ESP_OK) return BLE_ATT_ERR_UNLIKELY;
    // 当前只支持固定会话，损坏的持久化内容不应被编码成有效协议。
    if (strcmp(session, "demo-001") != 0) return BLE_ATT_ERR_UNLIKELY;
    char state[256];
    int length = snprintf(state, sizeof(state),
        "{\"v\":1,\"device_id\":\"%s\",\"session_id\":\"demo-001\","
        "\"game_id\":\"qin_formation\",\"unlocked\":%s,\"completed\":%s,\"collected\":%s,\"exhibiting\":%s}",
        device, progress.unlocked ? "true" : "false", progress.completed ? "true" : "false",
        progress.collected ? "true" : "false", progress.exhibiting ? "true" : "false");
    if (length < 0 || length >= sizeof(state)) return BLE_ATT_ERR_INSUFFICIENT_RES;
    return os_mbuf_append(context->om, state, length) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static const struct ble_gatt_svc_def services[] = {
    {.type = BLE_GATT_SVC_TYPE_PRIMARY, .uuid = &service_uuid.u,
     .characteristics = (struct ble_gatt_chr_def[]){
         {.uuid = &identity_uuid.u, .access_cb = read_value, .flags = BLE_GATT_CHR_F_READ},
         {.uuid = &state_uuid.u, .access_cb = read_value, .flags = BLE_GATT_CHR_F_READ, .arg = (void *)1},
         {0}}},
    {0}};

static int register_services(void)
{
    int result = ble_gatts_count_cfg(services);
    return result == 0 ? ble_gatts_add_svcs(services) : result;
}

void exploration_ble_register(void)
{
    doit_ble_gatt_cb_register(register_services);
}
