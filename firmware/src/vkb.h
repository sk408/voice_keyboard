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
};

void app_led_debug(enum app_led_code code);

/* --- USB HID keyboard (usb_kbd.c) --- */
int usb_kbd_init(void);
bool usb_kbd_ready(void);
/* Submit one boot-protocol keyboard report (mods + single key, 0 = none). */
int usb_kbd_report(uint8_t mods, uint8_t key);

/* --- BLE NUS peripheral (ble.c) --- */
int ble_init(void);
/* TX status notify (PROTOCOL.md: 0x00 idle, 0x01 busy), best effort. */
void ble_notify_status(uint8_t status);
/* Open the 60 s bonding window (called on dongle button press). */
void ble_open_pairing_window(void);

/* --- Typing engine (typing.c) --- */
/* Feed received NUS RX bytes into the keystroke stream (any chunking). */
void typing_feed(const void *data, uint16_t len);
/* Drop all pending keystrokes (e.g. on disconnect). */
void typing_reset(void);

#endif /* VKB_H_ */
