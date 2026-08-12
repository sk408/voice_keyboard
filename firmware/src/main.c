/* Voice Keyboard — application glue: LED feedback, pairing button, init. */

#include <zephyr/kernel.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/fatal.h>

#include <zephyr/logging/log.h>
LOG_MODULE_REGISTER(main, LOG_LEVEL_INF);

#include "vkb.h"

/* Green LED (led0): slow blink = advertising, solid = connected. */
static const struct gpio_dt_spec led = GPIO_DT_SPEC_GET(DT_ALIAS(led0), gpios);

/* Red debug LED (led1): temporary bring-up aid, see DEBUG_NOTES.md. */
static const struct gpio_dt_spec dbg_led =
	GPIO_DT_SPEC_GET_OR(DT_ALIAS(led1), gpios, {0});

static uint8_t dbg_pulses;
static uint16_t dbg_on_ms;
static uint16_t dbg_off_ms;
static bool dbg_led_on;

static void dbg_led_work_handler(struct k_work *work);

static K_WORK_DELAYABLE_DEFINE(dbg_led_work, dbg_led_work_handler);

static void dbg_led_work_handler(struct k_work *work)
{
	ARG_UNUSED(work);

	if (dbg_led_on) {
		gpio_pin_set_dt(&dbg_led, 0);
		dbg_led_on = false;
		if (dbg_pulses > 0) {
			k_work_reschedule(&dbg_led_work, K_MSEC(dbg_off_ms));
		}
		return;
	}

	if (dbg_pulses > 0) {
		dbg_pulses--;
		gpio_pin_set_dt(&dbg_led, 1);
		dbg_led_on = true;
		k_work_reschedule(&dbg_led_work, K_MSEC(dbg_on_ms));
	}
}

/* Boot-stage trace (v5.1): N slow red blinks = stage N completed, so a
 * boot hang on the headless dongle is pinpointed by the last code seen.
 * Codes (execution order, documented in DEBUG_NOTES.md):
 *   1 = main() entered, 2 = USB HID up, 3 = BLE stack up (bt_enable),
 *   4 = settings loaded (incl. macro store restore), 5 = advertising up.
 * No blinks at all = death before main() (kernel/driver init).
 */
void app_boot_stage(uint8_t stage)
{
	if (dbg_led.port == NULL) {
		return;
	}

	for (uint8_t i = 0; i < stage; i++) {
		gpio_pin_set_dt(&dbg_led, 1);
		k_msleep(80);
		gpio_pin_set_dt(&dbg_led, 0);
		k_msleep(80);
	}
	k_msleep(300); /* gap between stage codes */
}

/* Boot sub-stage markers (v5.2): long (400 ms) red blinks, used for the
 * sub-steps inside ble_init()'s bt_enable() path that the short stage
 * codes can't distinguish. See DEBUG_NOTES.md.
 */
void app_boot_mark(uint8_t count)
{
	if (dbg_led.port == NULL) {
		return;
	}

	for (uint8_t i = 0; i < count; i++) {
		gpio_pin_set_dt(&dbg_led, 1);
		k_msleep(400);
		gpio_pin_set_dt(&dbg_led, 0);
		k_msleep(400);
	}
	k_msleep(300);
}

/* Repeating fast blink: bt_enable() returned an error. Never returns. */
void app_boot_error_bt(void)
{
	for (;;) {
		if (dbg_led.port != NULL) {
			gpio_pin_set_dt(&dbg_led, 1);
			k_msleep(100);
			gpio_pin_set_dt(&dbg_led, 0);
		}
		k_msleep(100);
	}
}

/* Repeating 3-long-blink group: settings storage unrecoverable even
 * after erasing the partition. Never returns.
 */
void app_boot_error_settings(void)
{
	for (;;) {
		if (dbg_led.port != NULL) {
			for (uint8_t i = 0; i < 3; i++) {
				gpio_pin_set_dt(&dbg_led, 1);
				k_msleep(400);
				gpio_pin_set_dt(&dbg_led, 0);
				k_msleep(400);
			}
		}
		k_msleep(1200);
	}
}

/* Fatal-error handler (v5.2): a fault anywhere — including inside
 * bt_enable(), where the boot-stage trace can't see it — used to die
 * silently with the red LED frozen at the last stage code (no reset:
 * CONFIG_RESET_ON_FAULT=n). Signal it with a continuous slow (1 s) red
 * blink instead. Interrupts may be disabled here, so busy-wait, never
 * k_msleep().
 */
void k_sys_fatal_error_handler(unsigned int reason, const struct arch_esf *esf)
{
	ARG_UNUSED(esf);

	LOG_ERR("Fatal error %u", reason);

	if (dbg_led.port != NULL) {
		gpio_pin_configure_dt(&dbg_led, GPIO_OUTPUT_INACTIVE);
		for (;;) {
			gpio_pin_set_dt(&dbg_led, 1);
			k_busy_wait(1000000);
			gpio_pin_set_dt(&dbg_led, 0);
			k_busy_wait(1000000);
		}
	}

	for (;;) {
		/* halt */
	}
}

void app_led_debug(enum app_led_code code)
{
	if (dbg_led.port == NULL) {
		return;
	}

	switch (code) {
	case APP_LED_RX_WRITE:
		dbg_on_ms = 80; dbg_off_ms = 80; dbg_pulses = 1;
		break;
	case APP_LED_HID_SENT:
		dbg_on_ms = 80; dbg_off_ms = 80; dbg_pulses = 2;
		break;
	case APP_LED_HID_FAIL:
		dbg_on_ms = 120; dbg_off_ms = 120; dbg_pulses = 3;
		break;
	case APP_LED_HID_READY:
		dbg_on_ms = 1000; dbg_off_ms = 0; dbg_pulses = 1;
		break;
	case APP_LED_MOUSE_RX:
		dbg_on_ms = 60; dbg_off_ms = 60; dbg_pulses = 4;
		break;
	case APP_LED_ABS_RX:
		dbg_on_ms = 60; dbg_off_ms = 60; dbg_pulses = 5;
		break;
	case APP_LED_MACRO_PLAY:
		dbg_on_ms = 60; dbg_off_ms = 60; dbg_pulses = 6;
		break;
	default:
		return;
	}

	if (!dbg_led_on) {
		k_work_reschedule(&dbg_led_work, K_NO_WAIT);
	}
}

/* Onboard button (sw0): short press opens the 60 s pairing window; long
 * press (>1.5 s) with no BLE connection plays macro slot 0 over USB (v5).
 */
static const struct gpio_dt_spec button = GPIO_DT_SPEC_GET(DT_ALIAS(sw0), gpios);

#define LONG_PRESS_MS	1500

static int64_t press_start;
static bool press_valid;

enum led_state {
	LED_OFF,
	LED_BLINK,
	LED_ON,
};

static volatile enum led_state led_state = LED_OFF;
static bool led_level;

void app_led_advertising(void)
{
	led_state = LED_BLINK;
}

void app_led_connected(void)
{
	led_state = LED_ON;
	gpio_pin_set_dt(&led, 1);
	led_level = true;
}

void app_led_off(void)
{
	led_state = LED_OFF;
	gpio_pin_set_dt(&led, 0);
	led_level = false;
}

static void led_timer_handler(struct k_timer *timer)
{
	ARG_UNUSED(timer);

	if (led_state == LED_BLINK) {
		led_level = !led_level;
		gpio_pin_set_dt(&led, led_level);
	}
}

/* 500 ms toggle -> 1 Hz blink. */
static K_TIMER_DEFINE(led_timer, led_timer_handler, NULL);

static void button_work_handler(struct k_work *work)
{
	ARG_UNUSED(work);

	/* Debounced: sample the pin after the delay. Interrupts fire on both
	 * edges, so this runs once per settled press and once per release.
	 */
	if (gpio_pin_get_dt(&button) == 1) {
		press_start = k_uptime_get();
		press_valid = true;
		return;
	}

	if (!press_valid) {
		return;
	}
	press_valid = false;

	if (k_uptime_get() - press_start >= LONG_PRESS_MS) {
		/* Long press: standalone macro trigger, only while no central
		 * is connected (macro_play is a no-op when slot 0 is empty).
		 */
		if (!ble_is_connected()) {
			LOG_INF("Long press: playing macro 0");
			macro_play(0);
		} else {
			LOG_INF("Long press ignored (BLE connected)");
		}
		return;
	}

	LOG_INF("Button pressed");
	ble_open_pairing_window();
}

static K_WORK_DELAYABLE_DEFINE(button_work, button_work_handler);

static void button_isr(const struct device *dev,
		       struct gpio_callback *cb, uint32_t pins)
{
	ARG_UNUSED(dev); ARG_UNUSED(cb); ARG_UNUSED(pins);

	k_work_reschedule(&button_work, K_MSEC(30));
}

static struct gpio_callback button_cb_data;

static int button_init(void)
{
	int ret;

	if (!gpio_is_ready_dt(&button)) {
		LOG_ERR("Button device not ready");
		return -ENODEV;
	}

	ret = gpio_pin_configure_dt(&button, GPIO_INPUT);
	if (ret) {
		return ret;
	}

	ret = gpio_pin_interrupt_configure_dt(&button, GPIO_INT_EDGE_BOTH);
	if (ret) {
		return ret;
	}

	gpio_init_callback(&button_cb_data, button_isr, BIT(button.pin));
	gpio_add_callback(button.port, &button_cb_data);

	return 0;
}

int main(void)
{
	int ret;

	if (gpio_is_ready_dt(&led)) {
		gpio_pin_configure_dt(&led, GPIO_OUTPUT_INACTIVE);
	} else {
		LOG_WRN("LED not available, continuing without it");
	}

	if (dbg_led.port != NULL && gpio_is_ready_dt(&dbg_led)) {
		gpio_pin_configure_dt(&dbg_led, GPIO_OUTPUT_INACTIVE);
	}

	k_timer_start(&led_timer, K_MSEC(500), K_MSEC(500));

	app_boot_stage(1);

	ret = button_init();
	if (ret) {
		LOG_ERR("Button init failed (%d), pairing window unusable", ret);
	}

	ret = usb_kbd_init();
	if (ret) {
		LOG_ERR("USB init failed (%d)", ret);
		return ret;
	}

	app_boot_stage(2);

	ret = ble_init();
	if (ret) {
		LOG_ERR("BLE init failed (%d)", ret);
		return ret;
	}

	LOG_INF("Voice Keyboard ready");
	return 0;
}
