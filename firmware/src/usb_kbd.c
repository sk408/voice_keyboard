/* Voice Keyboard — USB HID composite keyboard + mouse + absolute pointer
 * + consumer control (next USB device stack).
 *
 * Single HID interface, one report descriptor with four report IDs:
 *   ID 1 = keyboard (8-byte boot-style input report + LED output report)
 *   ID 2 = mouse (buttons + X/Y/wheel, signed relative int8)
 *   ID 3 = absolute pointer (buttons + X/Y absolute uint16, 0..32767)
 *   ID 4 = consumer control (16-bit consumer/media usage)
 * The host enumerates one USB device exposing all four functions.
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
#define VKB_REPORT_ID_CONSUMER	4

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

enum consumer_report_idx {
	CONSUMER_REPORT_ID_IDX = 0,
	CONSUMER_USAGE_LO,
	CONSUMER_USAGE_HI,
	CONSUMER_REPORT_COUNT = 3, /* report ID byte + 16-bit usage */
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
	 * uint16 0..32767. A Generic Desktop Pointer collection with absolute
	 * X/Y (the standard "absolute mouse"/tablet shape, as in QEMU's
	 * usb-tablet): the host maps the logical extent linearly to the
	 * screen (no pointer acceleration) and button usages 1..3 ride as
	 * left/middle/right exactly like the relative mouse above.
	 */
	HID_USAGE_PAGE(HID_USAGE_GEN_DESKTOP),
	HID_USAGE(HID_USAGE_GEN_DESKTOP_POINTER),
	HID_COLLECTION(HID_COLLECTION_APPLICATION),
		HID_REPORT_ID(VKB_REPORT_ID_ABS),
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
	/* Consumer Control — input report ID 4: a single 16-bit consumer
	 * usage (media keys: Play/Pause 0xCD, Vol+ 0xE9, Vol- 0xEA,
	 * Mute 0xE2, next 0xB5, prev 0xB6, …). Usage page 0x0C (Consumer),
	 * usage 0x01 (Consumer Control). The 16-bit field is an array over
	 * the bounded 0..0x3FF usage range (the standard Consumer page
	 * extent) so the host maps the reported value straight to the
	 * consumer/media key — Usage Min 0 keeps "report value == usage"
	 * (see DEBUG_NOTES.md v6.2). Report = ID byte + 2 data bytes = 3
	 * bytes (must match CONSUMER_REPORT_COUNT exactly).
	 */
	HID_USAGE_PAGE(0x0C),
	HID_USAGE(0x01),
	HID_COLLECTION(HID_COLLECTION_APPLICATION),
		HID_REPORT_ID(VKB_REPORT_ID_CONSUMER),
		HID_USAGE_MIN16(0, 0),
		HID_USAGE_MAX16(0xFF, 0x03),
		HID_LOGICAL_MIN16(0, 0),
		HID_LOGICAL_MAX16(0xFF, 0xFF),
		HID_REPORT_SIZE(16),
		HID_REPORT_COUNT(1),
		/* HID_INPUT (Data,Array,Abs) */
		HID_INPUT(0x00),
	HID_END_COLLECTION,
};

static const struct device *hid_dev =
	DEVICE_DT_GET(DT_NODELABEL(hid_dev_0));

/*
 * Report buffers must satisfy the UDC driver alignment contract
 * (usbd_hid asserts IS_UDC_ALIGNED, but CONFIG_ASSERT is off in this
 * build, so a misaligned buffer would fail silently). Static buffers are
 * safe here because they are written ONLY by drain_next(), which holds the
 * single in-flight slot: a buffer is (re)written immediately before its
 * report is submitted, and input_report_done() clears in-flight before the
 * next submit, so a buffer can never be overwritten while its transfer is
 * still outstanding. The submit functions never touch these buffers — they
 * build the report directly into a FIFO node, and drain_next() copies the
 * node into the matching buffer right before submitting (the byte copy also
 * keeps the FIFO node's possibly-unaligned data out of the UDC DMA path).
 * The buffers double as the last-report state for kb_get_report().
 */
UDC_STATIC_BUF_DEFINE(kb_report, KB_REPORT_COUNT);
UDC_STATIC_BUF_DEFINE(ms_report, MS_REPORT_COUNT);
UDC_STATIC_BUF_DEFINE(ab_report, AB_REPORT_COUNT);
UDC_STATIC_BUF_DEFINE(consumer_report, CONSUMER_REPORT_COUNT);

/* Per-interface "reports sent to host" drain counters, incremented from the
 * input_report_done callback (a report is only "sent to host" once the host
 * has clocked it off the interrupt IN endpoint and the callback fires).
 * Read+reset atomically by the periodic HIDStatusNotification via
 * usb_hid_drain_counts(). The absolute pointer (touchscreen) and
 * consumer-control reports both count into the consumer drain figure,
 * matching InputStick's "touchscreen rides the consumer queue" model
 * (status byte [9] = consumer reports sent).
 */
static atomic_t kbd_sent;
static atomic_t mouse_sent;
static atomic_t consumer_sent;

/* Written by the USBD thread, read by the typing thread. */
static atomic_t kb_ready;

/* v6.5-diagnostic: throttle timestamp for the per-completion red-LED pulse
 * and RTT log. Replaces the v6.2 one-shot kb_sent_pulse_done: the pulse now
 * fires on EVERY input_report_done (any report ID), at most once per 300 ms,
 * so the human can see whether the completion callback actually fires on
 * hardware. Initialized negative so the very first completion always fires.
 */
static int64_t kb_done_pulse_last = -300;

/* --- non-blocking HID submit queue (v6.2) -------------------------------
 *
 * One HID interface, one interrupt-IN endpoint, four report IDs — so there
 * is at most ONE report in flight at a time, shared across all four report
 * types. Producers build a report directly into a queue node and enqueue;
 * drain_next() copies the node into the aligned static buffer and submits
 * at most one node at a time, and the USB stack calls
 * kb_input_report_done() when that transfer completes, which frees the slot
 * for the next node. This decouples BLE RX from USB TX: a
 * slow/stopped host fills the bounded queue (K_NO_WAIT) instead of wedging
 * the dispatch thread inside hid_device_submit_report().
 */
enum hid_report_type {
	HID_REPORT_KBD = 0,
	HID_REPORT_MOUSE,
	HID_REPORT_ABS,
	HID_REPORT_CONSUMER,
};

struct hid_report_node {
	uint8_t type;
	uint8_t data[KB_REPORT_COUNT]; /* max of the four report sizes */
};

/* v6.7: 256, not 128. This is a SINGLE queue shared by all four report
 * types (kbd / mouse / abs / consumer), but the app models per-interface
 * capacity — 128 keyboard + 64 mouse + 64 consumer = 256 reports in flight
 * (fw >= 100). At 128 the firmware would silently drop the surplus with no
 * drain credit (k_msgq_put K_NO_WAIT), leaking the app's freeSpace. 256 is
 * sufficient because the app self-limits each interface to 128/64/64 and
 * the drain (~1000 reports/s at 1 ms polling) empties the queue far faster
 * than the app can fill it. RAM cost is ~256 * sizeof(struct
 * hid_report_node) ≈ 2.6 KB of the ~206 KB free.
 */
#define HID_REPORT_Q_DEPTH 256

K_MSGQ_DEFINE(hid_report_q, sizeof(struct hid_report_node),
	      HID_REPORT_Q_DEPTH, 4);

/* Non-zero while a report is in flight (submitted, not yet completed). */
static atomic_t report_in_flight;

static void drain_next(void)
{
	struct hid_report_node node;
	uint8_t *buf;
	uint16_t len;
	int ret;

	/* Single in-flight slot shared across all four report types: claim
	 * it atomically so the dispatch thread and the USB-completion
	 * callback can never submit two reports at once.
	 */
	if (!atomic_cas(&report_in_flight, 0, 1)) {
		return;
	}

	while (k_msgq_get(&hid_report_q, &node, K_NO_WAIT) == 0) {
		switch (node.type) {
		case HID_REPORT_KBD:
			buf = kb_report;
			len = KB_REPORT_COUNT;
			break;
		case HID_REPORT_MOUSE:
			buf = ms_report;
			len = MS_REPORT_COUNT;
			break;
		case HID_REPORT_ABS:
			buf = ab_report;
			len = AB_REPORT_COUNT;
			break;
		case HID_REPORT_CONSUMER:
			buf = consumer_report;
			len = CONSUMER_REPORT_COUNT;
			break;
		default:
			continue; /* corrupt node, drop */
		}

		memcpy(buf, node.data, len);

		ret = hid_device_submit_report(hid_dev, len, buf);
		if (ret == 0) {
			/* in-flight stays 1 until kb_input_report_done() */
			return;
		}

		/* Submit failed (e.g. interface not enabled or the IN pool
		 * momentarily exhausted): drop this report, try the next.
		 * Never wedge.
		 */
		app_led_debug(APP_LED_HID_FAIL);
		LOG_WRN("HID submit failed (%d), report dropped", ret);
	}

	/* Queue drained (or all remaining submits failed): release the slot. */
	atomic_set(&report_in_flight, 0);
}

static void kb_input_report_done(const struct device *dev,
				 const uint8_t *const report)
{
	ARG_UNUSED(dev);

	/* v6.5-diagnostic: pulse the red LED + log on EVERY completion,
	 * throttled to one per ~300 ms so it is human-visible. This callback
	 * runs in USB-stack context and fires up to ~1000/s while the host
	 * polls; a 2-blink + LOG_INF every 300 ms is the ground-truth signal
	 * that input_report_done IS reached on hardware (and that the drain
	 * counters below are being incremented). Non-blocking by design:
	 * app_led_debug() only reschedules a workqueue item.
	 */
	if (k_uptime_get() - kb_done_pulse_last >= 300) {
		kb_done_pulse_last = k_uptime_get();
		app_led_debug(APP_LED_HID_SENT);
		LOG_INF("HID report done: report[0]=0x%02x", report[0]);
	}

	/* The report pointer is the static buffer we submitted, so report[0]
	 * is the report-ID byte: 1=kbd, 2=mouse, 3=abs, 4=consumer.
	 */
	switch (report[0]) {
	case VKB_REPORT_ID_KBD:
		atomic_inc(&kbd_sent);
		break;
	case VKB_REPORT_ID_MOUSE:
		atomic_inc(&mouse_sent);
		break;
	case VKB_REPORT_ID_ABS:
	case VKB_REPORT_ID_CONSUMER:
		atomic_inc(&consumer_sent);
		break;
	default:
		break;
	}

	atomic_set(&report_in_flight, 0);
	drain_next();
}

static void kb_iface_ready(const struct device *dev, const bool ready)
{
	LOG_INF("HID interface %s", ready ? "ready" : "not ready");
	atomic_set(&kb_ready, ready);
	if (ready) {
		app_led_debug(APP_LED_HID_READY);
		/* v6.0: if the InputStick handshake already finished, this is
		 * what finally sends the Ready notification (USB can enumerate
		 * after the BLE handshake).
		 */
		inputstick_usb_ready();
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
	case VKB_REPORT_ID_CONSUMER:
		report = consumer_report;
		size = CONSUMER_REPORT_COUNT;
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
	.input_report_done = kb_input_report_done,
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
	struct hid_report_node node;
	int ret;

	if (!atomic_get(&kb_ready)) {
		app_led_debug(APP_LED_HID_FAIL);
		return -ENOTCONN;
	}

	/* Build the report directly into the FIFO node; the static buffer is
	 * written only by drain_next() immediately before submit.
	 */
	memset(&node, 0, sizeof(node));
	node.type = HID_REPORT_KBD;
	node.data[KB_REPORT_ID_IDX] = VKB_REPORT_ID_KBD;
	node.data[KB_MOD_KEY] = mods;
	node.data[KB_KEY_CODE1] = key;

	ret = k_msgq_put(&hid_report_q, &node, K_NO_WAIT);
	if (ret) {
		app_led_debug(APP_LED_HID_FAIL);
		LOG_WRN("HID queue full, keyboard report dropped");
		return -ENOBUFS;
	}

	drain_next();
	return 0;
}

int usb_mouse_report(uint8_t buttons, int dx, int dy, int wheel)
{
	struct hid_report_node node;
	int ret;

	if (!atomic_get(&kb_ready)) {
		app_led_debug(APP_LED_HID_FAIL);
		return -ENOTCONN;
	}

	/* The descriptor declares logical min/max -127..127. */
	memset(&node, 0, sizeof(node));
	node.type = HID_REPORT_MOUSE;
	node.data[MS_REPORT_ID_IDX] = VKB_REPORT_ID_MOUSE;
	node.data[MS_BUTTONS] = buttons;
	node.data[MS_DX] = (uint8_t)CLAMP(dx, -127, 127);
	node.data[MS_DY] = (uint8_t)CLAMP(dy, -127, 127);
	node.data[MS_WHEEL] = (uint8_t)CLAMP(wheel, -127, 127);

	ret = k_msgq_put(&hid_report_q, &node, K_NO_WAIT);
	if (ret) {
		app_led_debug(APP_LED_HID_FAIL);
		LOG_WRN("HID queue full, mouse report dropped");
		return -ENOBUFS;
	}

	drain_next();
	return 0;
}

int usb_abs_report(uint8_t buttons, uint16_t x, uint16_t y)
{
	struct hid_report_node node;
	int ret;

	if (!atomic_get(&kb_ready)) {
		app_led_debug(APP_LED_HID_FAIL);
		return -ENOTCONN;
	}

	/* The descriptor declares logical min/max 0..32767; x/y are uint16. */
	memset(&node, 0, sizeof(node));
	node.type = HID_REPORT_ABS;
	node.data[AB_REPORT_ID_IDX] = VKB_REPORT_ID_ABS;
	node.data[AB_BUTTONS] = buttons;
	node.data[AB_X_LO] = (uint8_t)x;
	node.data[AB_X_HI] = (uint8_t)(x >> 8);
	node.data[AB_Y_LO] = (uint8_t)y;
	node.data[AB_Y_HI] = (uint8_t)(y >> 8);

	ret = k_msgq_put(&hid_report_q, &node, K_NO_WAIT);
	if (ret) {
		app_led_debug(APP_LED_HID_FAIL);
		LOG_WRN("HID queue full, abs report dropped");
		return -ENOBUFS;
	}

	drain_next();
	return 0;
}

int usb_consumer_report(uint16_t usage)
{
	struct hid_report_node node;
	int ret;

	if (!atomic_get(&kb_ready)) {
		app_led_debug(APP_LED_HID_FAIL);
		return -ENOTCONN;
	}

	/* Descriptor declares a single 16-bit consumer usage (array over
	 * 0..0x3FF). Report = ID byte + usage LSB + usage MSB = 3 bytes.
	 */
	memset(&node, 0, sizeof(node));
	node.type = HID_REPORT_CONSUMER;
	node.data[CONSUMER_REPORT_ID_IDX] = VKB_REPORT_ID_CONSUMER;
	node.data[CONSUMER_USAGE_LO] = (uint8_t)usage;
	node.data[CONSUMER_USAGE_HI] = (uint8_t)(usage >> 8);

	ret = k_msgq_put(&hid_report_q, &node, K_NO_WAIT);
	if (ret) {
		app_led_debug(APP_LED_HID_FAIL);
		LOG_WRN("HID queue full, consumer report dropped");
		return -ENOBUFS;
	}

	drain_next();
	return 0;
}

void usb_hid_drain_counts(uint8_t *kbd, uint8_t *mouse, uint8_t *consumer)
{
	*kbd = (uint8_t)MIN(atomic_clear(&kbd_sent), 255);
	*mouse = (uint8_t)MIN(atomic_clear(&mouse_sent), 255);
	*consumer = (uint8_t)MIN(atomic_clear(&consumer_sent), 255);
}

/* v6.7: read WITHOUT resetting — the drain deltas are only committed
 * (subtracted) once the 0x2F that carries them is actually accepted into
 * the BLE notify queue. Otherwise a dropped notification would permanently
 * lose up to 255 credits per interface.
 */
void usb_hid_drain_counts_peek(uint8_t *kbd, uint8_t *mouse, uint8_t *consumer)
{
	*kbd = (uint8_t)MIN(atomic_get(&kbd_sent), 255);
	*mouse = (uint8_t)MIN(atomic_get(&mouse_sent), 255);
	*consumer = (uint8_t)MIN(atomic_get(&consumer_sent), 255);
}

/* Saturating subtract of a drain delta: decrement the counter by exactly the
 * reported delta, never below zero. The CAS loop (rather than a bare
 * atomic_sub) makes it race-safe — a completion can land between the peek
 * and the commit, or two status sends can race on the dispatch thread vs the
 * system workqueue; re-reading + re-clamping prevents an atomic_sub() from
 * wrapping the counter negative (which would surface as a bogus ~255 credit).
 */
static void drain_saturating_sub(atomic_t *counter, uint8_t delta)
{
	atomic_val_t old;
	atomic_val_t new;

	if (delta == 0) {
		return;
	}

	old = atomic_get(counter);
	for (;;) {
		new = (old > delta) ? (old - delta) : 0;
		if (atomic_cas(counter, old, new)) {
			return;
		}
		old = atomic_get(counter);
	}
}

/* v6.7: commit (subtract) exactly the deltas that were peeked and reported
 * in a successfully-queued 0x2F. Call only after the notify enqueue returned
 * 0. Any reports that completed after the peek stay in the counters for the
 * next status (self-healing).
 */
void usb_hid_drain_counts_commit(uint8_t kbd, uint8_t mouse, uint8_t consumer)
{
	drain_saturating_sub(&kbd_sent, kbd);
	drain_saturating_sub(&mouse_sent, mouse);
	drain_saturating_sub(&consumer_sent, consumer);
}

/* v6.7: credit the consumer drain counter without a USB submit. Used for
 * 0x22 reports with report ID 2 (System page): the descriptor exposes no
 * System Control collection, so the report cannot be forwarded — but the app
 * already decremented its consumer freeSpace for it, so crediting
 * consumer_sent keeps the per-report accounting 1:1 and prevents a freeSpace
 * leak.
 */
void usb_hid_consumer_credit(uint8_t count)
{
	atomic_add(&consumer_sent, count);
}
