cmake_minimum_required(VERSION 3.20)
project(qin_render_test C CXX ASM)
get_filename_component(PROJECT_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../.." ABSOLUTE)
set(FIRMWARE_BUILD_DIR "${PROJECT_ROOT}/build" CACHE PATH "固件构建目录")
if(NOT EXISTS "${FIRMWARE_BUILD_DIR}/sdkconfig" OR
   NOT EXISTS "${FIRMWARE_BUILD_DIR}/qin-assets/qin_assets_generated.h")
    message(FATAL_ERROR "请先通过 tools/build.sh 构建固件及正式图片")
endif()

# 解码选项取自实际固件配置，不在测试中硬编码修复所需的开关。
foreach(OPTION LV_USE_RLE LV_BIN_DECODER_RAM_LOAD)
    file(STRINGS "${FIRMWARE_BUILD_DIR}/sdkconfig" ENABLED REGEX "^CONFIG_${OPTION}=y$")
    if(ENABLED)
        set(${OPTION}_VALUE 1)
    else()
        set(${OPTION}_VALUE 0)
    endif()
endforeach()
add_compile_definitions(LV_USE_RLE=${LV_USE_RLE_VALUE}
    LV_BIN_DECODER_RAM_LOAD=${LV_BIN_DECODER_RAM_LOAD_VALUE})
set(LV_BUILD_CONF_PATH "${CMAKE_CURRENT_SOURCE_DIR}/lv_conf.h" CACHE PATH "" FORCE)
set(CONFIG_LV_BUILD_DEMOS OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_USE_THORVG_INTERNAL OFF CACHE BOOL "" FORCE)
add_subdirectory("${PROJECT_ROOT}/managed_components/lvgl__lvgl" lvgl)
add_executable(qin_render_test qin_render_test.c
    "${PROJECT_ROOT}/main/display/page/exploration/qin_art.c")
foreach(NAME head body legs reward)
    target_sources(qin_render_test PRIVATE "${FIRMWARE_BUILD_DIR}/qin-assets/qin_${NAME}.c")
endforeach()
target_include_directories(qin_render_test PRIVATE
    "${PROJECT_ROOT}/main/display/page/exploration"
    "${FIRMWARE_BUILD_DIR}/qin-assets")
target_link_libraries(qin_render_test PRIVATE lvgl m)
