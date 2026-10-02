# Network endpoint inventory

This document lists product and upstream network destinations visible in the source. Review and replace them before deploying a fork under a different service operator.

| Purpose | Configuration or source | Default destination | Default state |
|---|---|---|---|
| XiaoZhi OTA/server discovery | `CONFIG_OTA_URL` | `https://api.tenclass.net/xiaozhi/ota/` | Used by normal OTA flow |
| Custom firmware version check | `CONFIG_CUSTOM_OTA_VERSION_URL` | Empty placeholder | Disabled by default |
| Fixed WebSocket | `CONFIG_WEBSOCKET_URL` | `wss://api.tenclass.net/xiaozhi/v1/` | Disabled unless fixed mode is enabled |
| Fixed WebSocket token | `CONFIG_WEBSOCKET_ACCESS_TOKEN` | Empty | Disabled unless fixed mode is enabled |
| VB6824 OTA browser portal | `main/application.cc` | `http://vbota.esp32.cn/vbota` | Shown only for VB6824 OTA mode |
| VB6824 local-IP registration | `components/vb6824/https.c` | Placeholder endpoint | Requires VB6824 OTA support |
| QR content upload | `components/doit_min_program_upload/ble/gatt_svc.c` | Placeholder endpoint | Used by the upload flow |
| Simplified-to-Traditional STT conversion | `main/stt_simplified_to_traditional.h` | Plain-HTTP numeric IP endpoint | Feature disabled by default |
| SoftAP configuration page | `78/esp-wifi-connect` | `http://192.168.4.1` | Local device network only |
| Audio debugger | `CONFIG_AUDIO_DEBUG_UDP_SERVER` | `192.168.2.100:8000` | Disabled by default |

## Deployment requirements

- Assign an owner and privacy policy for every externally operated endpoint.
- Prefer authenticated HTTPS/WSS and verify server certificates.
- Do not ship a universal production token in `sdkconfig.defaults` or source control.
- Define OTA signing, rollback, release authorization, and incident-revocation procedures.
- Confirm what device identifiers, IP addresses, logs, audio, or user content each service receives.
- Disable features whose service is unavailable rather than silently falling back to an unrelated public endpoint.

The repository's static checks detect common secret formats and known internal development paths, but they do not prove that every endpoint is trustworthy or that no application-layer identifier is sensitive.
