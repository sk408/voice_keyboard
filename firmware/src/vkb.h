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
	APP_LED_MOUSE_RX,	/* 4 short blinks: mouse report received */
	APP_LED_ABS_RX,		/* 5 short blinks: absolute pointer report received */
	APP_LED_MACRO_PLAY,	/* 6 short blinks: macro playback (v5 only; unused since v5.14) */
	/* Connect-stage trace (v5.3): 200 ms pulses, see DEBUG_NOTES.md. */
	APP_LED_CONN_REJECT,	/* 7: unbonded peer rejected (v5.3-v5.8; no trigger since v6.0) */
	APP_LED_SEC_FAIL,	/* 8: security/pairing failed (v5.3-v5.8; no trigger since v6.0) */
	APP_LED_TX_SUB,		/* 9: central subscribed to NUS TX */
	APP_LED_NAME_READ,	/* 10: first encrypted read done (v5.x only; no trigger since v6.0) */
	/* InputStick trace (v6.0): 200 ms pulses, see DEBUG_NOTES.md v6.0. */
	APP_LED_IS_CRC_FAIL,	/* 11: InputStick packet CRC mismatch (200ms x2) */
	APP_LED_IS_PKT,		/* 12: InputStick control packet dispatched (200ms x3) */
	APP_LED_IS_READY,	/* 13: handshake done, Ready notification sent (200ms x4) */
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
/* Submit one consumer-control report (report ID 4): a 16-bit consumer
 * usage (media key). */
int usb_consumer_report(uint16_t usage);
/* Read and reset the per-interface "reports sent to host" drain counters
 * (keyboard / mouse / consumer). The absolute pointer and consumer-control
 * submits both count into the consumer figure (InputStick "consumer
 * queue"). Used by the periodic HIDStatusNotification. */
void usb_hid_drain_counts(uint8_t *kbd, uint8_t *mouse, uint8_t *consumer);

/* --- BLE NUS peripheral (ble.c) --- */
int ble_init(void);
/* Queue a packet for NUS TX notify, deferred to the system workqueue
 * (best effort; the v5.4 rule — never bt_gatt_notify() from the BT RX
 * thread). Safe to call from any non-BT-RX thread. */
int ble_notify(const void *data, uint16_t len);
/* True while a BLE connection is active. */
bool ble_is_connected(void);

/* --- InputStick protocol layer (inputstick.c) --- */
/* Feed received NUS RX bytes into the packet parser (any chunking). */
void inputstick_feed(const void *data, uint16_t len);
/* Reset the parser + handshake state on disconnect. */
void inputstick_reset(void);
/* Called by usb_kbd.c when the host configures the HID interface: if the
 * handshake has already completed, emit the Ready HIDStatusNotification. */
void inputstick_usb_ready(void);

/* v6.0: the v2..v5 legacy raw ASCII/escape typing engine (typing.c) is
 * superseded by the InputStick packet protocol and removed from the build
 * for good — the file stays in the tree as a reference (see DEBUG_NOTES.md
 * v6.0). The v5.14 note about the removed macro store also still applies:
 * macro.c is out of the build and its declarations are gone (git history
 * v5.13, 1ce9ca0).
 */

#endif /* VKB_H_ */
