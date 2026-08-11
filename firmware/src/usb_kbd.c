/* Voice Keyboard — USB HID composite keyboard + mouse + absolute pointer
 * (next USB device stack).
 *
 * Single HID interface, one report descriptor with three report IDs:
 *   ID 1 = keyboard (8-byte boot-style input report + LED output report)
 *   ID 2 = mouse (buttons + X/Y/wheel, signed relative int8)
 *   ID 3 = absolute pointer (digitizer-class: buttons + X/Y uint16, 0..32767)
 * The host enumerates one USB device exposing all three functions.
 *
 * Adapted from Zephyr's samples/subsys/usb/hid-keyboard.
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <string.h>

#include <zephyr/usb/usbd.h>
#include <zephyr/usb/class/usbd_hid.h>
#include <zephyr/drivers/usb/udc_buf.h>

#include <zephyr/logging/log.h>
LOG_MODULE_REGISTER(usb_kbd, LOG_LEVEL_INF);

#include "vkb.h"

/*
 * VID 0x1209 is pid.codes' community VID for open-source projects.
 * This PID is not officially registered; see README "Known limitations".
 */
#define VKB_USB_VID	0x1209
#define VKB_USB_PID	0x0001
#define VKB_USB_MAX_POWER	50 /* bMaxPower, 2 mA units (100 mA) */

#define VKB_REPORT_ID_KBD	1
#define VKB_REPORT_ID_MOUSE	2
#define VKB_REPORT_ID_ABS	3

enum kb_report_idx {
	KB_REPORT_ID_IDX = 0,
	KB_MOD_KEY,
	KB_RESERVED,
	KB_KEY_CODE1,
	KB_REPORT_COUNT = 9, /* report ID byte + 8-byte keyboard report */
};

enum ms_report_idx {
	MS_REPORT_ID_IDX = 0,
	MS_BUTTONS,
	MS_DX,
	MS_DY,
	MS_WHEEL,
	MS_REPORT_COUNT = 5, /* report ID byte + 4-byte mouse report */
};

enum ab_report_idx {
	AB_REPORT_ID_IDX = 0,
	AB_BUTTONS,
	AB_X_LO,
	AB_X_HI,
	AB_Y_LO,
	AB_Y_HI,
	AB_REPORT_COUNT = 6, /* report ID byte + 5-byte absolute pointer report */
};

/*
 * Composite report descriptor. The item sequences match
 * HID_KEYBOARD_REPORT_DESC() / HID_MOUSE_REPORT_DESC(3) exactly, with a
 * HID_REPORT_ID() added at the top of each application collection — the
 * macros cannot be reused because they open/close their own collections.
 * The input report sizes this defines (9, 5 and 6 bytes including the ID
 * byte) must agree byte-exactly with the send paths below; mismatch = the
 * host silently drops reports.
 */
static const uint8_t hid_report_desc[] = {
	/* Keyboard — input report ID 1: mods, reserved, 6-key array. */
	HID_USAGE_PAGE(HID_USAGE_GEN_DESKTOP),
	HID_USAGE(HID_USAGE_GEN_DESKTOP_KEYBOARD),
	HID_COLLECTION(HID_COLLECTION_APPLICATION),
		HID_REPORT_ID(VKB_REPORT_ID_KBD),
		HID_USAGE_PAGE(HID_USAGE_GEN_DESKTOP_KEYPAD),
		/* HID_USAGE_MINIMUM(Keyboard LeftControl) */
		HID_USAGE_MIN8(0xE0),
		/* HID_USAGE_MAXIMUM(Keyboard Right GUI) */
		HID_USAGE_MAX8(0xE7),
		HID_LOGICAL_MIN8(0),
		HID_LOGICAL_MAX8(1),
		HID_REPORT_SIZE(1),
		HID_REPORT_COUNT(8),
		/* HID_INPUT(Data,Var,Abs) — modifier byte */
		HID_INPUT(0x02),
		HID_REPORT_SIZE(8),
		HID_REPORT_COUNT(1),
		/* HID_INPUT(Cnst,Var,Abs) — reserved byte */
		HID_INPUT(0x03),
		HID_REPORT_SIZE(1),
		HID_REPORT_COUNT(5),
		HID_USAGE_PAGE(HID_USAGE_GEN_LEDS),
		/* HID_USAGE_MINIMUM(Num Lock) */
		HID_USAGE_MIN8(1),
		/* HID_USAGE_MAXIMUM(Kana) */
		HID_USAGE_MAX8(5),
		/* HID_OUTPUT(Data,Var,Abs) — LED output report (ID 1) */
		HID_OUTPUT(0x02),
		HID_REPORT_SIZE(3),
		HID_REPORT_COUNT(1),
		/* HID_OUTPUT(Cnst,Var,Abs) */
		HID_OUTPUT(0x03),
		HID_REPORT_SIZE(8),
		HID_REPORT_COUNT(6),
		HID_LOGICAL_MIN8(0),
		HID_LOGICAL_MAX8(101),
		HID_USAGE_PAGE(HID_USAGE_GEN_DESKTOP_KEYPAD),
		/* HID_USAGE_MIN8(Reserved) */
		HID_USAGE_MIN8(0),
		/* HID_USAGE_MAX8(Keyboard Application) */
		HID_USAGE_MAX8(101),
		/* HID_INPUT (Data,Ary,Abs) — 6-key rollover array */
		HID_INPUT(0x00),
	HID_END_COLLECTION,
	/* Mouse — input report ID 2: 3 buttons, X/Y/wheel relative int8. */
	HID_USAGE_PAGE(HID_USAGE_GEN_DESKTOP),
	HID_USAGE(HID_USAGE_GEN_DESKTOP_MOUSE),
	HID_COLLECTION(HID_COLLECTION_APPLICATION),
		HID_REPORT_ID(VKB_REPORT_ID_MOUSE),
		HID_USAGE(HID_USAGE_GEN_DESKTOP_POINTER),
		HID_COLLECTION(HID_COLLECTION_PHYSICAL),
			/* Bits used for button signalling */
			HID_USAGE_PAGE(HID_USAGE_GEN_BUTTON),
			HID_USAGE_MIN8(1),
			HID_USAGE_MAX8(3),
			HID_LOGICAL_MIN8(0),
			HID_LOGICAL_MAX8(1),
			HID_REPORT_SIZE(1),
			HID_REPORT_COUNT(3),
			/* HID_INPUT (Data,Var,Abs) */
			HID_INPUT(0x02),
			/* Unused bits */
			HID_REPORT_SIZE(5),
			HID_REPORT_COUNT(1),
			/* HID_INPUT (Cnst,Ary,Abs) */
			HID_INPUT(1),
			/* X and Y axis, scroll */
			HID_USAGE_PAGE(HID_USAGE_GEN_DESKTOP),
			HID_USAGE(HID_USAGE_GEN_DESKTOP_X),
			HID_USAGE(HID_USAGE_GEN_DESKTOP_Y),
			HID_USAGE(HID_USAGE_GEN_DESKTOP_WHEEL),
			HID_LOGICAL_MIN8(-127),
			HID_LOGICAL_MAX8(127),
			HID_REPORT_SIZE(8),
			HID_REPORT_COUNT(3),
			/* HID_INPUT (Data,Var,Rel) */
			HID_INPUT(0x06),
		HID_END_COLLECTION,
	HID_END_COLLECTION,
	/* Absolute pointer — input report ID 3: 3 buttons, X/Y absolute
	 * uint16 0..32767 (digitizer-class; the host maps the logical
	 * extent linearly to the screen).
	 */
	/* HID Usage Page (Digitizer 0x0D) — no Zephyr constant */
	HID_USAGE_PAGE(0x0D),
	/* HID_USAGE(Touch Screen 0x04) */
	HID_USAGE(0x04),
	HID_COLLECTION(HID_COLLECTION_APPLICATION),
		HID_REPORT_ID(VKB_REPORT_ID_ABS),
		/* HID_USAGE(Finger 0x22) */
		HID_USAGE(0x22),
		HID_COLLECTION(HID_COLLECTION_LOGICAL),
			/* Bits used for button signalling */
			HID_USAGE_PAGE(HID_USAGE_GEN_BUTTON),
			HID_USAGE_MIN8(1),
			HID_USAGE_MAX8(3),
			HID_LOGICAL_MIN8(0),
			HID_LOGICAL_MAX8(1),
			HID_REPORT_SIZE(1),
			HID_REPORT_COUNT(3),
			/* HID_INPUT (Data,Var,Abs) */
			HID_INPUT(0x02),
			/* Unused bits */
			HID_REPORT_SIZE(5),
			HID_REPORT_COUNT(1),
			/* HID_INPUT (Cnst,Var,Abs) */
			HID_INPUT(0x03),
			/* X and Y axis, absolute */
			HID_USAGE_PAGE(HID_USAGE_GEN_DESKTOP),
			HID_USAGE(HID_USAGE_GEN_DESKTOP_X),
			HID_USAGE(HID_USAGE_GEN_DESKTOP_Y),
			HID_LOGICAL_MIN16(0, 0),
			HID_LOGICAL_MAX16(0xFF, 0x7F), /* 32767 */
			HID_REPORT_SIZE(16),
			HID_REPORT_COUNT(2),
			/* HID_INPUT (Data,Var,Abs) */
			HID_INPUT(0x02),
		HID_END_COLLECTION,
	HID_END_COLLECTION,
};

static const struct device *hid_dev =
	DEVICE_DT_GET(DT_NODELABEL(hid_dev_0));

/*
 * Report buffers must satisfy the UDC driver alignment contract
 * (usbd_hid asserts IS_UDC_ALIGNED, but CONFIG_ASSERT is off in this
 * build, so a misaligned buffer would fail silently). Static buffers are
 * safe here: submission is synchronous (this build registers no
 * input_report_done callback, so hid_device_submit_report() blocks until
 * the host has clocked the report out) and there is a single producer
 * (the typing thread). They also serve as the last-report state for
 * hid_get_report().
 */
UDC_STATIC_BUF_DEFINE(kb_report, KB_REPORT_COUNT);
UDC_STATIC_BUF_DEFINE(ms_report, MS_REPORT_COUNT);
UDC_STATIC_BUF_DEFINE(ab_report, AB_REPORT_COUNT);

/* Written by the USBD thread, read by the typing thread. */
static atomic_t kb_ready;

/* One-shot "host clocked out the first report" debug pulse per session. */
static bool kb_sent_pulse_done;

static void kb_iface_ready(const struct device *dev, const bool ready)
{
	LOG_INF("HID interface %s", ready ? "ready" : "not ready");
	atomic_set(&kb_ready, ready);
	if (ready) {
		kb_sent_pulse_done = false;
		app_led_debug(APP_LED_HID_READY);
	}
}

static int kb_get_report(const struct device *dev,
			 const uint8_t type, const uint8_t id, const uint16_t len,
			 uint8_t *const buf)
{
	const uint8_t *report;
	uint16_t size;

	ARG_UNUSED(dev);

	/*
	 * Answer GET_REPORT(INPUT) with the last submitted report for the
	 * requested ID. With report IDs in the descriptor the buffer must
	 * include the ID byte, so the static report buffers are returned
	 * verbatim. A non-positive return stalls the control pipe (usbd_hid
	 * maps it to a protocol error), which some host HID stacks treat as
	 * a device malfunction during enumeration/driver start.
	 */
	if (type != HID_REPORT_TYPE_INPUT) {
		return -ENOTSUP;
	}

	switch (id) {
	case VKB_REPORT_ID_KBD:
		report = kb_report;
		size = KB_REPORT_COUNT;
		break;
	case VKB_REPORT_ID_MOUSE:
		report = ms_report;
		size = MS_REPORT_COUNT;
		break;
	case VKB_REPORT_ID_ABS:
		report = ab_report;
		size = AB_REPORT_COUNT;
		break;
	default:
		return -ENOTSUP;
	}

	size = MIN(len, size);
	memcpy(buf, report, size);
	return size;
}

static int kb_set_report(const struct device *dev,
			 const uint8_t type, const uint8_t id, const uint16_t len,
			 const uint8_t *const buf)
{
	/* Output report: keyboard LEDs (Num/Caps/Scroll Lock) — ignored. */
	ARG_UNUSED(dev); ARG_UNUSED(type); ARG_UNUSED(id);
	ARG_UNUSED(len); ARG_UNUSED(buf);
	return 0;
}

static uint32_t kb_duration;

static void kb_set_idle(const struct device *dev,
			const uint8_t id, const uint32_t duration)
{
	ARG_UNUSED(dev); ARG_UNUSED(id);
	kb_duration = duration;
}

static uint32_t kb_get_idle(const struct device *dev, const uint8_t id)
{
	ARG_UNUSED(dev); ARG_UNUSED(id);
	return kb_duration;
}

static void kb_set_protocol(const struct device *dev, const uint8_t proto)
{
	ARG_UNUSED(dev);
	LOG_INF("Protocol: %s", proto == 0U ? "boot" : "report");
}

static void kb_output_report(const struct device *dev, const uint16_t len,
			     const uint8_t *const buf)
{
	kb_set_report(dev, HID_REPORT_TYPE_OUTPUT, 0U, len, buf);
}

static const struct hid_device_ops kb_ops = {
	.iface_ready = kb_iface_ready,
	.get_report = kb_get_report,
	.set_report = kb_set_report,
	.set_idle = kb_set_idle,
	.get_idle = kb_get_idle,
	.set_protocol = kb_set_protocol,
	.output_report = kb_output_report,
};

USBD_DEVICE_DEFINE(vkb_usbd,
		   DEVICE_DT_GET(DT_NODELABEL(zephyr_udc0)),
		   VKB_USB_VID, VKB_USB_PID);

USBD_DESC_LANG_DEFINE(vkb_lang);
USBD_DESC_MANUFACTURER_DEFINE(vkb_mfr, "VoiceKB");
USBD_DESC_PRODUCT_DEFINE(vkb_product, "VoiceKB Keyboard");
USBD_DESC_CONFIG_DEFINE(vkb_fs_cfg_desc, "FS Configuration");

USBD_CONFIGURATION_DEFINE(vkb_fs_config,
			  USB_SCD_SELF_POWERED,
			  VKB_USB_MAX_POWER, &vkb_fs_cfg_desc);

static void msg_cb(struct usbd_context *const usbd_ctx,
		   const struct usbd_msg *const msg)
{
	if (usbd_can_detect_vbus(usbd_ctx)) {
		if (msg->type == USBD_MSG_VBUS_READY) {
			if (usbd_enable(usbd_ctx)) {
				LOG_ERR("Failed to enable device support");
			}
		}

		if (msg->type == USBD_MSG_VBUS_REMOVED) {
			if (usbd_disable(usbd_ctx)) {
				LOG_ERR("Failed to disable device support");
			}
		}
	}
}

int usb_kbd_init(void)
{
	struct usbd_context *uds = &vkb_usbd;
	int ret;

	if (!device_is_ready(hid_dev)) {
		LOG_ERR("HID device is not ready");
		return -ENODEV;
	}

	ret = hid_device_register(hid_dev,
				  hid_report_desc, sizeof(hid_report_desc),
				  &kb_ops);
	if (ret != 0) {
		LOG_ERR("Failed to register HID device, %d", ret);
		return ret;
	}

	ret = usbd_add_descriptor(uds, &vkb_lang);
	if (ret) {
		goto err;
	}

	ret = usbd_add_descriptor(uds, &vkb_mfr);
	if (ret) {
		goto err;
	}

	ret = usbd_add_descriptor(uds, &vkb_product);
	if (ret) {
		goto err;
	}

	ret = usbd_add_configuration(uds, USBD_SPEED_FS, &vkb_fs_config);
	if (ret) {
		goto err;
	}

	ret = usbd_register_all_classes(uds, USBD_SPEED_FS, 1, NULL);
	if (ret) {
		goto err;
	}

	/* Always use class code information from interface descriptors. */
	usbd_device_set_code_triple(uds, USBD_SPEED_FS, 0, 0, 0);

	ret = usbd_msg_register_cb(uds, msg_cb);
	if (ret) {
		goto err;
	}

	ret = usbd_init(uds);
	if (ret) {
		goto err;
	}

	if (!usbd_can_detect_vbus(uds)) {
		ret = usbd_enable(uds);
		if (ret) {
			goto err;
		}
	}

	LOG_INF("USB HID composite keyboard+mouse initialized");
	return 0;

err:
	LOG_ERR("USB init failed, %d", ret);
	return ret;
}

bool usb_kbd_ready(void)
{
	return atomic_get(&kb_ready) != 0;
}

int usb_kbd_report(uint8_t mods, uint8_t key)
{
	int ret;

	if (!atomic_get(&kb_ready)) {
		app_led_debug(APP_LED_HID_FAIL);
		return -ENOTCONN;
	}

	memset(kb_report, 0, KB_REPORT_COUNT);
	kb_report[KB_REPORT_ID_IDX] = VKB_REPORT_ID_KBD;
	kb_report[KB_MOD_KEY] = mods;
	kb_report[KB_KEY_CODE1] = key;

	ret = hid_device_submit_report(hid_dev, KB_REPORT_COUNT, kb_report);
	if (ret) {
		app_led_debug(APP_LED_HID_FAIL);
	} else if (!kb_sent_pulse_done) {
		/* Submit is synchronous: a success means the host actually
		 * polled the report off the interrupt IN endpoint.
		 */
		kb_sent_pulse_done = true;
		app_led_debug(APP_LED_HID_SENT);
	}

	return ret;
}

int usb_mouse_report(uint8_t buttons, int dx, int dy, int wheel)
{
	int ret;

	if (!atomic_get(&kb_ready)) {
		app_led_debug(APP_LED_HID_FAIL);
		return -ENOTCONN;
	}

	/* The descriptor declares logical min/max -127..127. */
	ms_report[MS_REPORT_ID_IDX] = VKB_REPORT_ID_MOUSE;
	ms_report[MS_BUTTONS] = buttons;
	ms_report[MS_DX] = (uint8_t)CLAMP(dx, -127, 127);
	ms_report[MS_DY] = (uint8_t)CLAMP(dy, -127, 127);
	ms_report[MS_WHEEL] = (uint8_t)CLAMP(wheel, -127, 127);

	ret = hid_device_submit_report(hid_dev, MS_REPORT_COUNT, ms_report);
	if (ret) {
		app_led_debug(APP_LED_HID_FAIL);
	}

	return ret;
}

int usb_abs_report(uint8_t buttons, uint16_t x, uint16_t y)
{
	int ret;

	if (!atomic_get(&kb_ready)) {
		app_led_debug(APP_LED_HID_FAIL);
		return -ENOTCONN;
	}

	/* The descriptor declares logical min/max 0..32767; x/y are uint16. */
	ab_report[AB_REPORT_ID_IDX] = VKB_REPORT_ID_ABS;
	ab_report[AB_BUTTONS] = buttons;
	ab_report[AB_X_LO] = (uint8_t)x;
	ab_report[AB_X_HI] = (uint8_t)(x >> 8);
	ab_report[AB_Y_LO] = (uint8_t)y;
	ab_report[AB_Y_HI] = (uint8_t)(y >> 8);

	ret = hid_device_submit_report(hid_dev, AB_REPORT_COUNT, ab_report);
	if (ret) {
		app_led_debug(APP_LED_HID_FAIL);
	}

	return ret;
}
