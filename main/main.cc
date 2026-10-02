#include <esp_log.h>
#include <esp_err.h>
#include <nvs.h>
#include <nvs_flash.h>
#include <driver/gpio.h>
#include <esp_event.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "application.h"
#include "system_info.h"
#include "services/exploration/exploration_ble.h"

#define TAG "main"

extern "C" void app_main(void)
{
    // Initialize the default event loop
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    // NVS also contains exploration progress; never erase it during startup.
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGE(TAG, "NVS initialization failed (%s); preserving stored data. "
                      "Explicit recovery is required before startup.", esp_err_to_name(ret));
    }
    ESP_ERROR_CHECK(ret);

    exploration_ble_register();

    // Launch the application
    auto& app = Application::GetInstance();
    app.Start();
}
