/* Voice Keyboard — internal interfaces */

#ifndef VKB_H_
#define VKB_H_

#include <stdint.h>
#include <stdbool.h>

/* --- app LED hooks (implemented in main.c, used by ble.c) --- */
void app_led_advertising(void);
void app_led_connected(void);
void app_led_off(void);

/* Temporary bring-up aid: red LED (led1) blink codes, see DEBUG_NOTES.md. */
enum app_led_code {
	APP_LED_RX_WRITE,	/* 1 short blink: NUS RX bytes received */
	APP_LED_HID_SENT,	/* 2 short blinks: host clocked out first report */
	APP_LED_HID_FAIL,	/* 3 blinks: HID report submit failed/not ready */
	APP_LED_HID_READY,	/* solid 1 s: host configured the HID interface */
	APP_LED_MOUSE_RX,	/* 4 short blinks: mouse packet received */
	APP_LED_ABS_RX,		/* 5 short blinks: absolute pointer packet received */
	APP_LED_MACRO_PLAY,	/* 6 short blinks: macro playback started */
};

void app_led_debug(enum app_led_code code);
/* Boot-stage trace (v5.1): red blink N = boot stage N completed. */
void app_boot_stage(uint8_t stage);
/* Boot sub-stage markers (v5.2): long (400 ms) blinks, see DEBUG_NOTES.md. */
void app_boot_mark(uint8_t count);
/* Repeating fast blink: bt_enable() returned an error. Never returns. */
void app_boot_error_bt(void);
/* Repeating 3-long-blink group: settings storage unrecoverable. Never returns. */
void app_boot_error_settings(void);

/* --- USB HID composite keyboard + mouse (usb_kbd.c) --- */
int usb_kbd_init(void);
bool usb_kbd_ready(void);
/* Submit one keyboard report (report ID 1: mods + single key, 0 = none). */
int usb_kbd_report(uint8_t mods, uint8_t key);
/* Submit one mouse report (report ID 2). Deltas are clamped to [-127, 127]. */
int usb_mouse_report(uint8_t buttons, int dx, int dy, int wheel);
/* Submit one absolute pointer report (report ID 3). x/y: 0..32767. */
int usb_abs_report(uint8_t buttons, uint16_t x, uint16_t y);

/* --- BLE NUS peripheral (ble.c) --- */
int ble_init(void);
/* TX status notify (PROTOCOL.md: 0x00 idle, 0x01 busy), best effort. */
void ble_notify_status(uint8_t status);
/* TX error codes (0xE0+), sent on the same NUS TX characteristic. */
#define VKB_TX_ERR_STORE_FULL	0xE1	/* macro store budget exhausted */
/* Open the 60 s bonding window (called on dongle button press). */
void ble_open_pairing_window(void);
/* True while a BLE connection is active (gates the macro trigger). */
bool ble_is_connected(void);
/* Notify MACRO_LIST subscribers that the store changed (macro.c). */
void ble_notify_macro_list(const uint8_t *json, uint16_t len);

/* --- Macro store (macro.c), see README.md v5 section --- */
/* MACRO_LIST read value: JSON array, e.g. [{"i":0,"name":"x","len":412}]. */
const uint8_t *macro_list_json(uint16_t *len);
/* MACRO_RW write handler: returns 0, or a negative BT_ATT_ERR_* code. */
int macro_write(const uint8_t *buf, uint16_t len);
/* MACRO_RW read value: response prepared by the last "get" write. */
const uint8_t *macro_get_response(uint16_t *len);
/* Abort a put mid-transfer (e.g. on disconnect). */
void macro_abort_put(void);
/* Assemble settings-restored chunks into slots; call after settings_load(). */
void macro_boot_finalize(void);
/* Play a stored macro through the typing engine (async; no-op if empty). */
void macro_play(uint8_t index);

/* --- Typing engine (typing.c) --- */
/* Feed received NUS RX bytes into the keystroke stream (any chunking). */
void typing_feed(const void *data, uint16_t len);
/* Feed bytes like typing_feed(), but block until all of them are queued
 * (macro playback; the ring drains at typing speed).
 */
void typing_play(const void *data, uint16_t len);
/* Drop all pending keystrokes (e.g. on disconnect). */
void typing_reset(void);

#endif /* VKB_H_ */
