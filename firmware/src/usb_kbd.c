/* Voice Keyboard — USB HID keyboard (next USB device stack).
 *
 * Adapted from Zephyr's samples/subsys/usb/hid-keyboard.
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>

#include <zephyr/usb/usbd.h>
#include <zephyr/usb/class/usbd_hid.h>

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

enum kb_report_idx {
	KB_MOD_KEY = 0,
	KB_RESERVED,
	KB_KEY_CODE1,
	KB_REPORT_COUNT = 8,
};

static const uint8_t hid_report_desc[] = HID_KEYBOARD_REPORT_DESC();

static const struct device *hid_dev =
	DEVICE_DT_GET(DT_NODELABEL(hid_dev_0));

static bool kb_ready;

static void kb_iface_ready(const struct device *dev, const bool ready)
{
	LOG_INF("HID interface %s", ready ? "ready" : "not ready");
	kb_ready = ready;
}

static int kb_get_report(const struct device *dev,
			 const uint8_t type, const uint8_t id, const uint16_t len,
			 uint8_t *const buf)
{
	ARG_UNUSED(dev); ARG_UNUSED(type); ARG_UNUSED(id);
	ARG_UNUSED(len); ARG_UNUSED(buf);
	return -ENOTSUP;
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

	LOG_INF("USB HID keyboard initialized");
	return 0;

err:
	LOG_ERR("USB init failed, %d", ret);
	return ret;
}

bool usb_kbd_ready(void)
{
	return kb_ready;
}

int usb_kbd_report(uint8_t mods, uint8_t key)
{
	uint8_t report[KB_REPORT_COUNT] = {0};

	if (!kb_ready) {
		return -ENOTCONN;
	}

	report[KB_MOD_KEY] = mods;
	report[KB_KEY_CODE1] = key;

	return hid_device_submit_report(hid_dev, KB_REPORT_COUNT, report);
}
