/* Voice Keyboard — typing engine.
 *
 * Consumes the NUS RX byte stream (any BLE chunking) and emits USB HID
 * keyboard/mouse reports, keystrokes on a US layout, rate-limited to
 * ~15 ms/keystroke. Mouse and absolute pointer packets are forwarded
 * without the keystroke rate limit. See PROTOCOL.md for the byte stream
 * contract, including the v2 modifier (0x81/0x82/0x83), mouse (0x90) and
 * v4 absolute pointer (0x91) escapes.
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

/*
 * Escape parser state. 0x00 introduces an escape; the following code byte
 * selects either a special key (single parameter-less byte) or one of the
 * multi-byte sequences (0x81/0x82 take one mask byte, 0x90 takes four
 * parameter bytes, 0x91 takes five). All states survive chunk boundaries:
 * a sequence is only resolved once every byte of it has arrived.
 */
#define ESC_NONE	0	/* not inside an escape sequence */
#define ESC_CODE	1	/* 0x00 seen, waiting for the escape code byte */

static uint8_t esc_state = ESC_NONE; /* ESC_NONE/ESC_CODE, or pending 0x81/0x82/0x90/0x91 */
static uint8_t mouse_params[4];	/* buttons, dx, dy, wheel for a pending 0x90 */
static uint8_t mouse_got;
static uint8_t abs_params[5];	/* buttons, x_lo, x_hi, y_lo, y_hi for a pending 0x91 */
static uint8_t abs_got;
static bool busy;

/* Modifier state (v2): bitmask = HID report byte 0. */
static uint8_t held_mods;	/* 0x82: stay down until 0x83 or disconnect */
static uint8_t sticky_mods;	/* 0x81: apply to the next keystroke only */
static bool release_mods_pending; /* deferred release-all on disconnect */

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
	esc_state = ESC_NONE;
	mouse_got = 0;
	abs_got = 0;

	/* A disconnect while modifiers were held must not leave them stuck
	 * on the host. This runs on the BLE RX thread, where the blocking
	 * HID submit must not be called, so defer the release report to the
	 * typing thread.
	 */
	if (held_mods != 0 || sticky_mods != 0) {
		held_mods = 0;
		sticky_mods = 0;
		release_mods_pending = true;
		k_sem_give(&rx_sem);
	}
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

/* One keystroke: press, short hold, release, inter-key gap. Held
 * modifiers (0x82) stay down across keystrokes; sticky modifiers (0x81)
 * apply to this keystroke and auto-release with it.
 */
static void tap(uint8_t mod, uint8_t key)
{
	if (key == 0) {
		return;
	}

	uint8_t mods = mod | held_mods | sticky_mods;

	sticky_mods = 0;
	if (usb_kbd_report(mods, key) == 0) {
		k_msleep(KEY_PRESS_MS);
		usb_kbd_report(held_mods, 0);
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

/* 0x90 mouse packet complete: buttons (bit0 left, bit1 right, bit2
 * middle) + signed dx/dy/wheel, per PROTOCOL.md v2.
 */
static void handle_mouse_packet(void)
{
	app_led_debug(APP_LED_MOUSE_RX);
	usb_mouse_report(mouse_params[0],
			 (int8_t)mouse_params[1],
			 (int8_t)mouse_params[2],
			 (int8_t)mouse_params[3]);
}

/* 0x91 absolute pointer packet complete: buttons (bit0 left, bit1 right,
 * bit2 middle) + x/y uint16 LE 0..32767, per PROTOCOL.md v4.
 */
static void handle_abs_packet(void)
{
	app_led_debug(APP_LED_ABS_RX);
	usb_abs_report(abs_params[0],
		       (uint16_t)abs_params[1] | ((uint16_t)abs_params[2] << 8),
		       (uint16_t)abs_params[3] | ((uint16_t)abs_params[4] << 8));
}

/* Parameter byte of a pending multi-byte escape (0x81/0x82/0x90/0x91). */
static void handle_escape_param(uint8_t b)
{
	switch (esc_state) {
	case 0x81: /* sticky-arm modifiers for the next keystroke */
		sticky_mods = b;
		esc_state = ESC_NONE;
		break;
	case 0x82: /* hold modifiers down until 0x83; press them now */
		held_mods = b;
		sticky_mods = 0;
		esc_state = ESC_NONE;
		usb_kbd_report(held_mods, 0);
		break;
	case 0x90: /* mouse packet: buttons, dx, dy, wheel */
		mouse_params[mouse_got++] = b;
		if (mouse_got == sizeof(mouse_params)) {
			mouse_got = 0;
			esc_state = ESC_NONE;
			handle_mouse_packet();
		}
		break;
	case 0x91: /* absolute pointer packet: buttons, x_lo, x_hi, y_lo, y_hi */
		abs_params[abs_got++] = b;
		if (abs_got == sizeof(abs_params)) {
			abs_got = 0;
			esc_state = ESC_NONE;
			handle_abs_packet();
		}
		break;
	default:
		esc_state = ESC_NONE;
		break;
	}
}

/* Escape code byte (the byte after 0x00), per PROTOCOL.md. */
static void handle_escape_code(uint8_t b)
{
	switch (b) {
	case 0x81: /* sticky-arm: one mask byte follows */
	case 0x82: /* hold: one mask byte follows */
		esc_state = b;
		return;
	case 0x83: /* release all modifiers */
		held_mods = 0;
		sticky_mods = 0;
		usb_kbd_report(0, 0);
		return;
	case 0x90: /* mouse: four parameter bytes follow */
		mouse_got = 0;
		esc_state = b;
		return;
	case 0x91: /* absolute pointer: five parameter bytes follow */
		abs_got = 0;
		esc_state = b;
		return;
	default:
		handle_escape(b);
		return;
	}
}

static void process_byte(uint8_t b)
{
	/* A pending escape survives chunk boundaries: each sequence is only
	 * resolved once all of its bytes have arrived.
	 */
	if (esc_state != ESC_NONE) {
		uint8_t pending = esc_state;

		if (pending != ESC_CODE) {
			handle_escape_param(b);
		} else {
			esc_state = ESC_NONE;
			handle_escape_code(b);
		}
		return;
	}

	switch (b) {
	case 0x00:
		esc_state = ESC_CODE;
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

		/* Deferred release-all from typing_reset() (disconnect while
		 * modifiers were held): unblock the host-side modifiers.
		 */
		if (release_mods_pending) {
			release_mods_pending = false;
			usb_kbd_report(0, 0);
		}

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
