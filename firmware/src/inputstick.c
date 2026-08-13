/* Voice Keyboard — InputStick protocol layer (v6.0).
 *
 * Speaks the InputStick packet protocol (see INPUTSTICK_EMULATION_SPEC.md)
 * on top of the NUS RX/TX characteristics so the free InputStick iOS/Android
 * apps connect, reach "Ready", and type. This replaces the v2..v5 legacy raw
 * ASCII/escape byte stream (typing.c) — v6 speaks InputStick only.
 *
 * Framing (spec §3):
 *   byte 0       : 0x55 start tag
 *   byte 1       : header = (length in 16-byte blocks, bits 0..5)
 *                          | flags (0x80 response, 0x40 encrypted, 0x20 HMAC)
 *   bytes 2..N-1 : payload, 16*blocks bytes, zero-padded:
 *                     payload[0..3]  CRC32 (IEEE 802.3 / zlib) big-endian,
 *                                    over payload[4..end]
 *                     payload[4]     command
 *                     payload[5]     param / response-code
 *                     payload[6..]   data
 *                  Notifications (dongle->app) omit the param byte:
 *                     data starts at payload[5].
 *
 * Threading (the v5.4 lesson): the byte-wise parser runs on the BT RX thread
 * (cheap: scan + CRC). Each complete, CRC-valid packet is queued to a
 * dedicated dispatch thread, which performs the blocking USB HID submits and
 * builds responses; bt_gatt_notify() is never called from the BT RX thread.
 */

#include <zephyr/kernel.h>
#include <zephyr/sys/crc.h>
#include <zephyr/sys/ring_buffer.h>
#include <zephyr/sys/util.h>
#include <string.h>

#include <zephyr/logging/log.h>
LOG_MODULE_REGISTER(inputstick, LOG_LEVEL_INF);

#include "vkb.h"

/* --- framing constants (spec §3) --- */
#define IS_TAG			0x55
#define IS_FLAG_HMAC		0x20
#define IS_FLAG_ENCRYPTED	0x40
#define IS_FLAG_RESPONSE	0x80
#define IS_MAX_BLOCKS		17
#define IS_BLOCK_SIZE		16
#define IS_MAX_PAYLOAD		(IS_MAX_BLOCKS * IS_BLOCK_SIZE) /* 272 */
#define IS_MAX_PACKET		(2 + IS_MAX_PAYLOAD)            /* 274 */

/* --- commands (spec §4) --- */
#define IS_CMD_IDENTIFY		0x01
#define IS_CMD_RUN_FIRMWARE	0x04
#define IS_CMD_GET_FW_INFO	0x10
#define IS_CMD_INIT		0x11	/* Android CMD_INIT = iOS WdgReset */
#define IS_CMD_HID_REQ_STATUS	0x20
#define IS_CMD_HID_KBD		0x21
#define IS_CMD_HID_MOUSE	0x23
#define IS_CMD_HID_TOUCH	0x26
#define IS_CMD_HID_CLEAR	0x2A
#define IS_CMD_HID_KBD_SHORT	0x2C
#define IS_CMD_HID_STATUS_NOTIF	0x2F
#define IS_CMD_SET_UPDATE_INTERVAL 0x31

#define IS_RESP_OK		0x01

/* Keystroke pacing for the dictation path (matches the v5 typing rate). */
#define KEY_PRESS_MS	5
#define KEY_GAP_MS	10

/* RX queue: complete packets handed from the BT RX thread to the dispatch
 * thread. 8 KB holds ~430 keyboard-short packets or ~29 max-size packets;
 * flow control (M3) will revisit this sizing.
 */
#define IS_RX_RING_SIZE	8192

RING_BUF_DECLARE(is_ring, IS_RX_RING_SIZE);
K_SEM_DEFINE(is_sem, 0, 64);

/* --- parser state (BT RX thread only) --- */
enum is_parse_state {
	IS_STATE_TAG,     /* scanning for 0x55 */
	IS_STATE_HEADER,  /* got 0x55, reading the header byte */
	IS_STATE_PAYLOAD, /* accumulating payload bytes */
};

static enum is_parse_state parse_state = IS_STATE_TAG;
static uint8_t pkt_payload[IS_MAX_PAYLOAD];
static uint16_t pkt_total; /* payload bytes to read = blocks * 16 */
static uint16_t pkt_len;   /* bytes accumulated so far */
static uint8_t pkt_flags;

/* Handshake / ready state (dispatch thread + USBD thread). */
static atomic_t handshake_done; /* SetUpdateInterval received */
static atomic_t ready_sent;     /* Ready HIDStatusNotification emitted */

/* Set by inputstick_reset() on the BT RX thread, honoured by the dispatch
 * thread (mirrors the typing.c reset_pending pattern).
 */
static atomic_t reset_pending;

/* --- packet building (dispatch thread) -------------------------------- */

static void build_payload(uint8_t *pl, uint16_t total, uint8_t cmd,
			  uint8_t param, const uint8_t *data, uint16_t data_len,
			  bool has_param)
{
	memset(pl, 0, total);
	pl[4] = cmd;
	if (has_param) {
		pl[5] = param;
		if (data && data_len) {
			memcpy(pl + 6, data, data_len);
		}
	} else if (data && data_len) {
		memcpy(pl + 5, data, data_len);
	}

	/* CRC over command(+param)+data+zero padding = pl[4..total-1]. */
	uint32_t crc = crc32_ieee(&pl[4], total - 4);

	pl[0] = (uint8_t)(crc >> 24);
	pl[1] = (uint8_t)(crc >> 16);
	pl[2] = (uint8_t)(crc >> 8);
	pl[3] = (uint8_t)crc;
}

/* Build a normal packet (command + param + data) into out; sets *out_len. */
static void build_packet(uint8_t cmd, uint8_t param, const uint8_t *data,
			 uint16_t data_len, uint8_t *out, uint16_t *out_len)
{
	uint16_t payload = 6 + data_len; /* CRC + cmd + param + data */
	uint16_t blocks = (uint16_t)(((payload - 1) >> 4) + 1);
	uint16_t total = blocks * IS_BLOCK_SIZE;

	out[0] = IS_TAG;
	out[1] = (uint8_t)blocks; /* flags = 0: no response/encrypt/HMAC */
	build_payload(out + 2, total, cmd, param, data, data_len, true);
	*out_len = 2 + total;
}

/* Build a notification packet (command + data, no param byte). */
static void build_notification(uint8_t cmd, const uint8_t *data,
			       uint16_t data_len, uint8_t *out,
			       uint16_t *out_len)
{
	uint16_t payload = 5 + data_len; /* CRC + cmd + data */
	uint16_t blocks = (uint16_t)(((payload - 1) >> 4) + 1);
	uint16_t total = blocks * IS_BLOCK_SIZE;

	out[0] = IS_TAG;
	out[1] = (uint8_t)blocks;
	build_payload(out + 2, total, cmd, 0, data, data_len, false);
	*out_len = 2 + total;
}

static void is_send(uint8_t cmd, uint8_t param, const uint8_t *data,
		    uint16_t data_len)
{
	uint8_t pkt[IS_MAX_PACKET];
	uint16_t len;

	build_packet(cmd, param, data, data_len, pkt, &len);
	ble_notify(pkt, len);
}

static void is_send_notification(uint8_t cmd, const uint8_t *data,
				 uint16_t data_len)
{
	uint8_t pkt[IS_MAX_PACKET];
	uint16_t len;

	build_notification(cmd, data, data_len, pkt, &len);
	ble_notify(pkt, len);
}

static void is_respond(uint8_t cmd, uint8_t resp_code, const uint8_t *data,
		       uint16_t data_len)
{
	is_send(cmd, resp_code, data, data_len);
}

/* --- handshake responses (spec §5, §5.1, §7, §9b) ---------------------- */

static void respond_fw_info(void)
{
	uint8_t info[19];

	memset(info, 0, sizeof(info));
	info[0] = 1;  /* firmwareType */
	info[1] = 1;  /* versionMajor */
	info[2] = 0;  /* versionMinor -> firmware version 100 */
	info[3] = 0;  /* versionHardware */
	/* info[4..16] reserved, zero */
	info[17] = 0x00; /* securityStatus */
	info[18] = 0x00; /* passwordProtection: no password -> skip auth */

	is_respond(IS_CMD_GET_FW_INFO, IS_RESP_OK, info, sizeof(info));
}

static void send_hid_status(void)
{
	uint8_t st[12];

	memset(st, 0, sizeof(st));
	st[0] = 0x05;  /* USB state = USBConfigured */
	st[1] = 0x00;  /* keyboard LEDs */
	st[2] = 0x01;  /* keyboard report protocol active */
	st[3] = 0x01;  /* keyboard buffer empty */
	st[4] = 0x01;  /* mouse report protocol active */
	st[5] = 0x01;  /* mouse buffer empty */
	st[6] = 0x01;  /* consumer buffer empty */
	/* st[7..9] drain counts = 0 (no flow-control buffer in M2) */
	/* st[10] reserved, zero */
	st[11] = 0xFF; /* Android marker: read the sent-to-host counts */

	is_send_notification(IS_CMD_HID_STATUS_NOTIF, st, sizeof(st));
}

static void try_send_ready(void)
{
	if (atomic_get(&ready_sent)) {
		return;
	}
	if (!atomic_get(&handshake_done)) {
		return;
	}
	if (!usb_kbd_ready()) {
		return;
	}

	atomic_set(&ready_sent, 1);
	send_hid_status();
	app_led_debug(APP_LED_IS_READY);
	LOG_INF("Ready: HIDStatusNotification (USBConfigured) sent");
}

/* --- HID report mapping (spec §6) -------------------------------------- */

/* KeyboardShort (0x2C): [modifiers, keycode] — a complete keystroke.
 * Press, short hold, release. This is the dictation path.
 */
static void tap(uint8_t mods, uint8_t key)
{
	if (key == 0) {
		return;
	}

	if (usb_kbd_report(mods, key) == 0) {
		k_msleep(KEY_PRESS_MS);
		usb_kbd_report(0, 0);
	}
	k_msleep(KEY_GAP_MS);
}

static void hid_kbd_short(const uint8_t *data, uint16_t data_len, uint8_t n)
{
	uint8_t count = MIN(n, (uint8_t)(data_len / 2));

	for (uint8_t i = 0; i < count; i++) {
		tap(data[i * 2], data[i * 2 + 1]);
	}
}

/* Keyboard (0x21): [mods, 0x00, key0..key5] — a press report (the app sends
 * its own release); we forward the first key (single-key rollover).
 */
static void hid_kbd(const uint8_t *data, uint16_t data_len, uint8_t n)
{
	uint8_t count = MIN(n, (uint8_t)(data_len / 8));

	for (uint8_t i = 0; i < count; i++) {
		const uint8_t *r = &data[i * 8];

		usb_kbd_report(r[0], r[2]);
	}
}

/* Mouse (0x23): [buttons, dx, dy, scroll]. */
static void hid_mouse(const uint8_t *data, uint16_t data_len, uint8_t n)
{
	uint8_t count = MIN(n, (uint8_t)(data_len / 4));

	for (uint8_t i = 0; i < count; i++) {
		const uint8_t *r = &data[i * 4];

		app_led_debug(APP_LED_MOUSE_RX);
		usb_mouse_report(r[0], (int8_t)r[1], (int8_t)r[2],
				 (int8_t)r[3]);
	}
}

/* TouchScreen (0x26): [reportID=4, tip+in_range, x_lsb, x_msb, y_lsb, y_msb].
 * x/y are 16-bit (0..65535); ours are 15-bit (0..32767) -> scale by 1 bit.
 */
static void hid_touch(const uint8_t *data, uint16_t data_len, uint8_t n)
{
	uint8_t count = MIN(n, (uint8_t)(data_len / 6));

	for (uint8_t i = 0; i < count; i++) {
		const uint8_t *r = &data[i * 6];
		uint8_t buttons = (r[1] & 0x01) ? 0x01 : 0x00; /* tip = left */
		uint16_t x = (uint16_t)(r[2] | (r[3] << 8));
		uint16_t y = (uint16_t)(r[4] | (r[5] << 8));

		app_led_debug(APP_LED_ABS_RX);
		usb_abs_report(buttons, (uint16_t)(x >> 1),
			       (uint16_t)(y >> 1));
	}
}

/* --- command dispatch (spec §4) ---------------------------------------- */

static void dispatch_packet(const uint8_t *payload, uint16_t total,
			    uint8_t flags)
{
	uint32_t crc_rx = ((uint32_t)payload[0] << 24) |
			  ((uint32_t)payload[1] << 16) |
			  ((uint32_t)payload[2] << 8) |
			  (uint32_t)payload[3];
	uint32_t crc_calc = crc32_ieee(&payload[4], total - 4);

	if (crc_rx != crc_calc) {
		LOG_WRN("CRC mismatch (rx 0x%08x calc 0x%08x)", crc_rx,
			crc_calc);
		app_led_debug(APP_LED_IS_CRC_FAIL);
		return;
	}

	if (flags & (IS_FLAG_ENCRYPTED | IS_FLAG_HMAC)) {
		LOG_WRN("encrypted/HMAC packet unsupported, dropped");
		return;
	}

	uint8_t cmd = payload[4];
	uint8_t param = payload[5];
	const uint8_t *data = &payload[6];
	uint16_t data_len = total - 6; /* includes zero padding */
	bool respond = (flags & IS_FLAG_RESPONSE) != 0;

	/* LED trace: blink on control/handshake packets, not HID bursts. */
	switch (cmd) {
	case IS_CMD_HID_KBD_SHORT:
	case IS_CMD_HID_KBD:
	case IS_CMD_HID_MOUSE:
	case IS_CMD_HID_TOUCH:
		break;
	default:
		app_led_debug(APP_LED_IS_PKT);
		break;
	}

	switch (cmd) {
	case IS_CMD_RUN_FIRMWARE:
		is_respond(IS_CMD_RUN_FIRMWARE, IS_RESP_OK, NULL, 0);
		break;
	case IS_CMD_GET_FW_INFO:
		respond_fw_info();
		break;
	case IS_CMD_INIT:
		is_respond(IS_CMD_INIT, IS_RESP_OK, NULL, 0);
		break;
	case IS_CMD_SET_UPDATE_INTERVAL:
		if (respond) {
			is_respond(IS_CMD_SET_UPDATE_INTERVAL, IS_RESP_OK,
				   NULL, 0);
		}
		atomic_set(&handshake_done, 1);
		try_send_ready();
		break;
	case IS_CMD_HID_REQ_STATUS:
		send_hid_status();
		break;
	case IS_CMD_HID_KBD_SHORT:
		hid_kbd_short(data, data_len, param);
		break;
	case IS_CMD_HID_KBD:
		hid_kbd(data, data_len, param);
		break;
	case IS_CMD_HID_MOUSE:
		hid_mouse(data, data_len, param);
		break;
	case IS_CMD_HID_TOUCH:
		hid_touch(data, data_len, param);
		break;
	case IS_CMD_HID_CLEAR:
		/* No report buffer in M2 -> nothing to clear. */
		if (respond) {
			is_respond(IS_CMD_HID_CLEAR, IS_RESP_OK, NULL, 0);
		}
		break;
	case IS_CMD_IDENTIFY:
		/* "Find device": the packet blink above already pulses the
		 * LED; reply defensively if a response was requested.
		 */
		if (respond) {
			is_respond(IS_CMD_IDENTIFY, IS_RESP_OK, NULL, 0);
		}
		break;
	default:
		if (respond) {
			is_respond(cmd, IS_RESP_OK, NULL, 0);
		}
		break;
	}
}

/* --- dispatch thread ---------------------------------------------------- */

static void queue_packet(void)
{
	uint32_t need = 3 + pkt_total; /* len(2) + flags(1) + payload */

	if (ring_buf_space_get(&is_ring) < need) {
		LOG_WRN("inputstick RX ring overflow, dropped packet");
		return;
	}

	uint8_t hdr[3] = {
		(uint8_t)(pkt_total & 0xFF),
		(uint8_t)(pkt_total >> 8),
		pkt_flags,
	};

	ring_buf_put(&is_ring, hdr, sizeof(hdr));
	ring_buf_put(&is_ring, pkt_payload, pkt_total);
	k_sem_give(&is_sem);
}

static void dispatch_thread(void *p1, void *p2, void *p3)
{
	ARG_UNUSED(p1); ARG_UNUSED(p2); ARG_UNUSED(p3);

	while (true) {
		uint8_t hdr[3];
		uint8_t payload[IS_MAX_PAYLOAD];
		uint32_t n;

		k_sem_take(&is_sem, K_FOREVER);

		if (atomic_get(&reset_pending)) {
			atomic_set(&reset_pending, 0);
			atomic_set(&handshake_done, 0);
			atomic_set(&ready_sent, 0);
			ring_buf_reset(&is_ring);
			continue;
		}

		n = ring_buf_get(&is_ring, hdr, sizeof(hdr));
		if (n < sizeof(hdr)) {
			continue;
		}

		uint16_t total = (uint16_t)(hdr[0] | (hdr[1] << 8));
		uint8_t flags = hdr[2];

		if (total < IS_BLOCK_SIZE || total > IS_MAX_PAYLOAD) {
			continue;
		}

		n = ring_buf_get(&is_ring, payload, total);
		if (n < total) {
			continue;
		}

		dispatch_packet(payload, total, flags);
	}
}

K_THREAD_DEFINE(is_tid, 3072, dispatch_thread, NULL, NULL, NULL,
		K_PRIO_PREEMPT(8), 0, 0);

/* --- public entry points ------------------------------------------------ */

/* Byte-wise parser, mirroring InputStickPacketParser.m. Runs on the BT RX
 * thread (nus_rx_write); cheap scan + CRC, no notify, no blocking HID.
 */
void inputstick_feed(const void *buf, uint16_t len)
{
	const uint8_t *p = buf;

	for (uint16_t i = 0; i < len; i++) {
		uint8_t b = p[i];

		switch (parse_state) {
		case IS_STATE_TAG:
			if (b == IS_TAG) {
				parse_state = IS_STATE_HEADER;
			}
			break;

		case IS_STATE_HEADER: {
			uint8_t blocks = b & 0x3F;

			pkt_flags = b & 0xE0;
			if (blocks < 1 || blocks > IS_MAX_BLOCKS) {
				parse_state = IS_STATE_TAG;
				break;
			}
			pkt_total = blocks * IS_BLOCK_SIZE;
			pkt_len = 0;
			parse_state = IS_STATE_PAYLOAD;
			break;
		}

		case IS_STATE_PAYLOAD:
			pkt_payload[pkt_len++] = b;
			if (pkt_len == pkt_total) {
				queue_packet();
				parse_state = IS_STATE_TAG;
			}
			break;
		}
	}
}

/* Called from ble.c's disconnected() (BT RX thread): reset parser state
 * directly, defer the ring/handshake reset to the dispatch thread.
 */
void inputstick_reset(void)
{
	parse_state = IS_STATE_TAG;
	pkt_len = 0;
	pkt_total = 0;
	atomic_set(&reset_pending, 1);
	k_sem_give(&is_sem);
}

/* Called from usb_kbd.c when the host configures the HID interface: if the
 * handshake has already completed, this is what finally sends the Ready
 * notification (USB can enumerate after the BLE handshake).
 */
void inputstick_usb_ready(void)
{
	try_send_ready();
}
