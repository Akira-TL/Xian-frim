#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
void cover_service_init(void);
bool cover_service_packet(uint16_t connection, const uint8_t *packet, size_t size);
void cover_service_status(uint8_t out[24]);
void cover_service_disconnect(uint16_t connection);
uint32_t cover_service_revision(void);
bool cover_service_copy(uint8_t **data, size_t *size, uint32_t *revision);
