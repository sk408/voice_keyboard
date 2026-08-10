/* Voice Keyboard — typing engine.
 *
 * Consumes the NUS RX byte stream (any BLE chunking) and emits USB HID
 * keyboard reports on a US layout, rate-limited to ~15 ms/keystroke.
 * See PROTOCOL.md for the byte stream contract.
 */

#include <zephyr/kernel.h>
#include <zephyr/sys/ring_buffer.h>
#include <zephyr/usb/class/hid.h>

#include <zephyr/logging/log.h>
LOG_MODULE_REGISTER(typing, LOG_LEVEL_INF);

#include "vkb.h"

#define RX_RING_SIZE	512
#define RX_CHUNK_MAX	64

/* ~15 ms per keystroke: press held 5 ms, then 10 ms idle after release. */
#define KEY_PRESS_MS	5
#define KEY_GAP_MS	10

RING_BUF_DECLARE(rx_ring, RX_RING_SIZE);
K_SEM_DEFINE(rx_sem, 0, 64);

static bool esc_pending;
static bool busy;

void typing_feed(const void *data, uint16_t len)
{
	uint32_t written = ring_buf_put(&rx_ring, data, len);

	if (written < len) {
		LOG_WRN("RX ring overflow, dropped %u bytes", len - written);
	}
	if (written > 0) {
		k_sem_give(&rx_sem);
	}
}

void typing_reset(void)
{
	k_sem_reset(&rx_sem);
	ring_buf_reset(&rx_ring);
	esc_pending = false;
}

/* Map printable US-ASCII to (modifier, HID keycode) on a US layout. */
static bool ascii_to_hid(uint8_t c, uint8_t *mod, uint8_t *key)
{
	*mod = 0;

	if (c >= 'a' && c <= 'z') {
		*key = HID_KEY_A + (c - 'a');
		return true;
	}
	if (c >= 'A' && c <= 'Z') {
		*mod = HID_KBD_MODIFIER_LEFT_SHIFT;
		*key = HID_KEY_A + (c - 'A');
		return true;
	}
	if (c >= '1' && c <= '9') {
		*key = HID_KEY_1 + (c - '1');
		return true;
	}

	switch (c) {
	case ' ': *key = HID_KEY_SPACE; break;
	case '0': *key = HID_KEY_0; break;
	case '-': *key = HID_KEY_MINUS; break;
	case '=': *key = HID_KEY_EQUAL; break;
	case '[': *key = HID_KEY_LEFTBRACE; break;
	case ']': *key = HID_KEY_RIGHTBRACE; break;
	case '\\': *key = HID_KEY_BACKSLASH; break;
	case ';': *key = HID_KEY_SEMICOLON; break;
	case '\'': *key = HID_KEY_APOSTROPHE; break;
	case '`': *key = HID_KEY_GRAVE; break;
	case ',': *key = HID_KEY_COMMA; break;
	case '.': *key = HID_KEY_DOT; break;
	case '/': *key = HID_KEY_SLASH; break;
	/* Shifted symbols (US layout) */
	case '!': *mod = HID_KBD_MODIFIER_LEFT_SHIFT; *key = HID_KEY_1; break;
	case '@': *mod = HID_KBD_MODIFIER_LEFT_SHIFT; *key = HID_KEY_2; break;
	case '#': *mod = HID_KBD_MODIFIER_LEFT_SHIFT; *key = HID_KEY_3; break;
	case '$': *mod = HID_KBD_MODIFIER_LEFT_SHIFT; *key = HID_KEY_4; break;
	case '%': *mod = HID_KBD_MODIFIER_LEFT_SHIFT; *key = HID_KEY_5; break;
	case '^': *mod = HID_KBD_MODIFIER_LEFT_SHIFT; *key = HID_KEY_6; break;
	case '&': *mod = HID_KBD_MODIFIER_LEFT_SHIFT; *key = HID_KEY_7; break;
	case '*': *mod = HID_KBD_MODIFIER_LEFT_SHIFT; *key = HID_KEY_8; break;
	case '(': *mod = HID_KBD_MODIFIER_LEFT_SHIFT; *key = HID_KEY_9; break;
	case ')': *mod = HID_KBD_MODIFIER_LEFT_SHIFT; *key = HID_KEY_0; break;
	case '_': *mod = HID_KBD_MODIFIER_LEFT_SHIFT; *key = HID_KEY_MINUS; break;
	case '+': *mod = HID_KBD_MODIFIER_LEFT_SHIFT; *key = HID_KEY_EQUAL; break;
	case '{': *mod = HID_KBD_MODIFIER_LEFT_SHIFT; *key = HID_KEY_LEFTBRACE; break;
	case '}': *mod = HID_KBD_MODIFIER_LEFT_SHIFT; *key = HID_KEY_RIGHTBRACE; break;
	case '|': *mod = HID_KBD_MODIFIER_LEFT_SHIFT; *key = HID_KEY_BACKSLASH; break;
	case ':': *mod = HID_KBD_MODIFIER_LEFT_SHIFT; *key = HID_KEY_SEMICOLON; break;
	case '"': *mod = HID_KBD_MODIFIER_LEFT_SHIFT; *key = HID_KEY_APOSTROPHE; break;
	case '~': *mod = HID_KBD_MODIFIER_LEFT_SHIFT; *key = HID_KEY_GRAVE; break;
	case '<': *mod = HID_KBD_MODIFIER_LEFT_SHIFT; *key = HID_KEY_COMMA; break;
	case '>': *mod = HID_KBD_MODIFIER_LEFT_SHIFT; *key = HID_KEY_DOT; break;
	case '?': *mod = HID_KBD_MODIFIER_LEFT_SHIFT; *key = HID_KEY_SLASH; break;
	default:
		return false;
	}

	return true;
}

/* One keystroke: press, short hold, release, inter-key gap. */
static void tap(uint8_t mod, uint8_t key)
{
	if (key == 0) {
		return;
	}

	if (usb_kbd_report(mod, key) == 0) {
		k_msleep(KEY_PRESS_MS);
		usb_kbd_report(0, 0);
	}
	k_msleep(KEY_GAP_MS);
}

/* 0x00-escaped special keys, per PROTOCOL.md. */
static void handle_escape(uint8_t code)
{
	uint8_t key = 0;

	switch (code) {
	case 0x01: key = HID_KEY_ESC; break;
	case 0x02: key = HID_KEY_UP; break;
	case 0x03: key = HID_KEY_DOWN; break;
	case 0x04: key = HID_KEY_LEFT; break;
	case 0x05: key = HID_KEY_RIGHT; break;
	case 0x06: key = HID_KEY_DELETE; break;
	case 0x07: key = HID_KEY_HOME; break;
	case 0x08: key = HID_KEY_END; break;
	case 0x09: key = HID_KEY_PAGEUP; break;
	case 0x0A: key = HID_KEY_PAGEDOWN; break;
	default:
		if (code >= 0x10 && code <= 0x1B) { /* F1-F12 */
			key = HID_KEY_F1 + (code - 0x10);
		} else {
			LOG_WRN("Unknown escape code 0x%02x, dropped", code);
			return;
		}
		break;
	}

	tap(0, key);
}

static void process_byte(uint8_t b)
{
	/* A pending escape survives chunk boundaries: the pair is only
	 * resolved once both bytes have arrived.
	 */
	if (esc_pending) {
		esc_pending = false;
		handle_escape(b);
		return;
	}

	switch (b) {
	case 0x00:
		esc_pending = true;
		break;
	case '\n':
		tap(0, HID_KEY_ENTER);
		break;
	case '\t':
		tap(0, HID_KEY_TAB);
		break;
	case 0x08:
		tap(0, HID_KEY_BACKSPACE);
		break;
	default:
		if (b >= 0x20 && b <= 0x7e) {
			uint8_t mod, key;

			if (ascii_to_hid(b, &mod, &key)) {
				tap(mod, key);
			}
		}
		/* Other control bytes and non-ASCII UTF-8 continuation/lead
		 * bytes cannot be typed on a US layout: dropped. See README.
		 */
		break;
	}
}

static void typing_thread(void *p1, void *p2, void *p3)
{
	ARG_UNUSED(p1); ARG_UNUSED(p2); ARG_UNUSED(p3);

	while (true) {
		uint8_t buf[RX_CHUNK_MAX];
		uint32_t n;

		k_sem_take(&rx_sem, K_FOREVER);

		n = ring_buf_get(&rx_ring, buf, sizeof(buf));
		if (n == 0) {
			continue;
		}

		if (!busy) {
			busy = true;
			ble_notify_status(0x01);
		}

		for (uint32_t i = 0; i < n; i++) {
			process_byte(buf[i]);
		}

		if (ring_buf_is_empty(&rx_ring)) {
			busy = false;
			ble_notify_status(0x00);
		}
	}
}

K_THREAD_DEFINE(typing_tid, 2048, typing_thread, NULL, NULL, NULL,
		K_PRIO_PREEMPT(8), 0, 0);
