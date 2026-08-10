/* Voice Keyboard — application glue: LED feedback, pairing button, init. */

#include <zephyr/kernel.h>
#include <zephyr/drivers/gpio.h>

#include <zephyr/logging/log.h>
LOG_MODULE_REGISTER(main, LOG_LEVEL_INF);

#include "vkb.h"

/* Green LED (led0): slow blink = advertising, solid = connected. */
static const struct gpio_dt_spec led = GPIO_DT_SPEC_GET(DT_ALIAS(led0), gpios);

/* Onboard button (sw0): opens the 60 s pairing window. */
static const struct gpio_dt_spec button = GPIO_DT_SPEC_GET(DT_ALIAS(sw0), gpios);

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

	/* Debounced: sample the pin after the delay. */
	if (gpio_pin_get_dt(&button) == 1) {
		LOG_INF("Button pressed");
		ble_open_pairing_window();
	}
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

	ret = gpio_pin_interrupt_configure_dt(&button, GPIO_INT_EDGE_TO_ACTIVE);
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

	k_timer_start(&led_timer, K_MSEC(500), K_MSEC(500));

	ret = button_init();
	if (ret) {
		LOG_ERR("Button init failed (%d), pairing window unusable", ret);
	}

	ret = usb_kbd_init();
	if (ret) {
		LOG_ERR("USB init failed (%d)", ret);
		return ret;
	}

	ret = ble_init();
	if (ret) {
		LOG_ERR("BLE init failed (%d)", ret);
		return ret;
	}

	LOG_INF("Voice Keyboard ready");
	return 0;
}
