#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define COVER_MAX_BYTES (48u * 1024u)
#define COVER_BANK_BYTES 65536u
#define COVER_DATA_OFFSET 4096u
#define COVER_CHUNK_BYTES 180u
typedef enum {COVER_IDLE, COVER_RECEIVING, COVER_SAVED, COVER_INVALID,
 COVER_STORAGE, COVER_BUSY, COVER_CANCELLED, COVER_TIMEOUT, COVER_CHECKSUM, COVER_IMAGE} cover_code_t;
typedef struct {
 void *context;
 bool (*read)(void *, uint32_t, void *, size_t);
 bool (*write)(void *, uint32_t, const void *, size_t);
 bool (*erase)(void *, uint32_t, size_t);
 bool (*validate)(const uint8_t *, size_t);
} cover_io_t;
typedef struct {
 cover_io_t io;
 int bank;
 uint32_t revision, saved_size, saved_crc, id, received, total, expected_crc;
 uint64_t touched;
 uint8_t *pending;
 cover_code_t code;
} cover_transfer_t;
uint32_t cover_crc32(const uint8_t *data, size_t size);
bool cover_transfer_init(cover_transfer_t *state, cover_io_t io);
void cover_transfer_abort(cover_transfer_t *state, cover_code_t code);
void cover_transfer_packet(cover_transfer_t *state, const uint8_t *packet, size_t size, uint64_t now);
void cover_transfer_status(cover_transfer_t *state, uint8_t out[24], uint64_t now);
bool cover_transfer_copy(cover_transfer_t *state, uint8_t **data, size_t *size);
