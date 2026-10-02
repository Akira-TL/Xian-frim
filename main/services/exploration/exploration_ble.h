#pragma once

#ifdef __cplusplus
extern "C" {
#endif

// 在 NimBLE 初始化前调用。当前服务只读，不提供无授权的解锁入口。
void exploration_ble_register(void);

#ifdef __cplusplus
}
#endif
