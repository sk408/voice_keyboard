/* Voice Keyboard — BLE peripheral (v6.0).
 *
 * Plain NUS peripheral: the standard Nordic UART service UUIDs with
 * unencrypted RX writes and no pairing/bonding — the InputStick iOS/Android
 * apps connect and write plaintext (see INPUTSTICK_EMULATION_SPEC.md §2).
 * The v5.3–v5.8 encryption/bonding machinery (bonded-peer gate, 60 s pairing
 * window, forced bt_conn_set_security, DisplayYesNo numeric-comparison
 * pairing, BT_GATT_PERM_WRITE_ENCRYPT) is stripped. The device advertises as
 * "InputStick".
 *
 * v5.14 removed the v5 MACRO_LIST/MACRO_RW macro-store characteristics for
 * good; macro.c stays in the tree as a reference but is excluded from the
 * build (see DEBUG_NOTES.md v5.14).
 */

#include <zephyr/kernel.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/settings/settings.h>
#include <zephyr/storage/flash_map.h>

#include <string.h>

#include <zephyr/logging/log.h>
LOG_MODULE_REGISTER(ble, LOG_LEVEL_INF);

#include "vkb.h"

/* Zephyr keeps settings_subsys_init() out of the public headers
 * (subsys/settings/src/settings_init.c). bt_enable() calls it internally
 * via bt_settings_init(); declared here so ble_init() can mount the
 * settings backend first — see ble_init().
 */
extern int settings_subsys_init(void);

/* Standard NUS UUIDs (we define the service in-app so the RX
 * characteristic uses plain BT_GATT_PERM_WRITE — Zephyr's built-in NUS
 * is equivalent, but defining it keeps the attribute layout explicit).
 */
#define VKB_UUID_NUS_SERVICE \
	BT_UUID_DECLARE_128(BT_UUID_128_ENCODE(0x6e400001, 0xb5a3, 0xf393, 0xe0a9, 0xe50e24dcca9e))
#define VKB_UUID_NUS_RX \
	BT_UUID_DECLARE_128(BT_UUID_128_ENCODE(0x6e400002, 0xb5a3, 0xf393, 0xe0a9, 0xe50e24dcca9e))
#define VKB_UUID_NUS_TX \
	BT_UUID_DECLARE_128(BT_UUID_128_ENCODE(0x6e400003, 0xb5a3, 0xf393, 0xe0a9, 0xe50e24dcca9e))

/* Fixed advertising/GAP name. */
#define DEVICE_NAME_DEFAULT	"InputStick"

static struct bt_conn *current_conn;
static bool tx_notif_enabled;

static ssize_t nus_rx_write(struct bt_conn *conn,
			    const struct bt_gatt_attr *attr,
			    const void *buf, uint16_t len,
			    uint16_t offset, uint8_t flags)
{
	ARG_UNUSED(conn); ARG_UNUSED(attr); ARG_UNUSED(offset); ARG_UNUSED(flags);

	app_led_debug(APP_LED_RX_WRITE);
	inputstick_feed(buf, len);
	return len;
}

static void nus_tx_ccc_changed(const struct bt_gatt_attr *attr, uint16_t value)
{
	ARG_UNUSED(attr);

	tx_notif_enabled = (value == BT_GATT_CCC_NOTIFY);
	if (tx_notif_enabled) {
		app_led_debug(APP_LED_TX_SUB);
	}
}

BT_GATT_SERVICE_DEFINE(nus_svc,
	BT_GATT_PRIMARY_SERVICE(VKB_UUID_NUS_SERVICE),
	BT_GATT_CHARACTERISTIC(VKB_UUID_NUS_TX,
		BT_GATT_CHRC_NOTIFY,
		BT_GATT_PERM_NONE,
		NULL, NULL, NULL),
	BT_GATT_CCC(nus_tx_ccc_changed,
		BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
	BT_GATT_CHARACTERISTIC(VKB_UUID_NUS_RX,
		BT_GATT_CHRC_WRITE | BT_GATT_CHRC_WRITE_WITHOUT_RESP,
		BT_GATT_PERM_WRITE,
		NULL, nus_rx_write, NULL),
);

/* Advertising data carries the fixed compiled-in name. */
static struct bt_data ad[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR),
	{
		.type = BT_DATA_NAME_COMPLETE,
		.data_len = sizeof(DEVICE_NAME_DEFAULT) - 1,
		.data = (const uint8_t *)DEVICE_NAME_DEFAULT,
	},
};

static const struct bt_data sd[] = {
	BT_DATA_BYTES(BT_DATA_UUID128_ALL,
		      BT_UUID_128_ENCODE(0x6e400001, 0xb5a3, 0xf393,
					 0xe0a9, 0xe50e24dcca9e)),
};

static void start_advertising(void)
{
	int err = bt_le_adv_start(BT_LE_ADV_CONN_FAST_2, ad, ARRAY_SIZE(ad),
				  sd, ARRAY_SIZE(sd));
	if (err) {
		LOG_ERR("Advertising failed to start (%d)", err);
		return;
	}

	app_led_advertising();
	LOG_INF("Advertising started");
}

/* --- Connection management --- */

static void connected(struct bt_conn *conn, uint8_t err)
{
	if (err) {
		LOG_ERR("Connection failed (err 0x%02x)", err);
		return;
	}

	current_conn = bt_conn_ref(conn);
	app_led_connected();
	LOG_INF("Connected");
}

static void disconnected(struct bt_conn *conn, uint8_t reason)
{
	ARG_UNUSED(conn);

	LOG_INF("Disconnected (reason 0x%02x)", reason);

	if (current_conn) {
		bt_conn_unref(current_conn);
		current_conn = NULL;
	}

	tx_notif_enabled = false;
	inputstick_reset();
	start_advertising();
}

BT_CONN_CB_DEFINE(conn_cbs) = {
	.connected = connected,
	.disconnected = disconnected,
};

/* --- Notifications ---------------------------------------------------------
 *
 * bt_gatt_notify() must never run on the BT RX thread (GATT write/CCC
 * callbacks included): for a notification it allocates a PDU from att_pool
 * (CONFIG_BT_ATT_TX_COUNT=3 here) with K_FOREVER unless the caller is the
 * system workqueue (Zephyr 4.1 att.c bt_att_chan_create_pdu()), and those
 * buffers are freed by ATT TX completion processing on that same RX thread.
 * A notify from inside a callback can therefore block the RX thread forever
 * and kill the whole ATT server — the v5.3/v5.4 hang. All notifications are
 * queued (K_MSGQ) and sent from the system workqueue, where the allocation
 * is K_NO_WAIT and the worst case is a dropped (best-effort) packet.
 *
 * nus_svc attribute layout:
 *   attrs[0] primary service, attrs[1] TX declaration,
 *   attrs[2] TX value, attrs[3] TX CCC,
 *   attrs[4] RX declaration, attrs[5] RX value.
 * Notifications must be sent on the VALUE attribute (attrs[2]); using
 * attrs[1] notifies the declaration handle, which no central subscribes to,
 * so every packet is silently dropped.
 */

#define BLE_NOTIFY_MAX_LEN	274 /* 2 (tag+hdr) + 272 (max payload) */

struct ble_notify_msg {
	uint16_t len;
	uint8_t data[BLE_NOTIFY_MAX_LEN];
};

K_MSGQ_DEFINE(ble_notify_msgq, sizeof(struct ble_notify_msg), 4, 4);

static void notify_work_fn(struct k_work *work)
{
	ARG_UNUSED(work);

	struct ble_notify_msg msg;

	while (k_msgq_get(&ble_notify_msgq, &msg, K_NO_WAIT) == 0) {
		if (!current_conn || !tx_notif_enabled) {
			continue;
		}

		int err = bt_gatt_notify(current_conn, &nus_svc.attrs[2],
					 msg.data, msg.len);

		if (err) {
			LOG_WRN("Notify failed (%d)", err);
		}
	}
}

static K_WORK_DEFINE(notify_work, notify_work_fn);

/* Queue a packet for TX notify; the actual notify runs on the system
 * workqueue. Safe to call from any non-BT-RX thread (best effort).
 */
int ble_notify(const void *data, uint16_t len)
{
	if (len > BLE_NOTIFY_MAX_LEN) {
		return -EINVAL;
	}

	struct ble_notify_msg msg;

	msg.len = len;
	memcpy(msg.data, data, len);

	if (k_msgq_put(&ble_notify_msgq, &msg, K_NO_WAIT) != 0) {
		LOG_WRN("Notify queue full, dropped");
		return -EAGAIN;
	}

	k_work_submit(&notify_work);
	return 0;
}

bool ble_is_connected(void)
{
	return current_conn != NULL;
}

/* Erase the whole settings storage partition. Used to recover from a
 * failed NVS mount on flash that previously held something else.
 */
static int storage_partition_erase(void)
{
	const struct flash_area *fa;
	int err = flash_area_open(FIXED_PARTITION_ID(storage_partition), &fa);

	if (err) {
		return err;
	}
	err = flash_area_flatten(fa, 0, fa->fa_size);
	flash_area_close(fa);
	return err;
}

int ble_init(void)
{
	int err;

	/* v5 moved the settings partition to 0xB4000, a flash region that
	 * older firmware could legally occupy or that may carry DFU residue.
	 * bt_enable() -> bt_init() -> bt_settings_init() mounts NVS on it and
	 * ABORTS bt_enable() on any mount error. Mount it ourselves first; on
	 * failure erase the partition and retry, so the mount always sees a
	 * valid (empty) NVS. A repair erase loses any stored settings.
	 */
	app_boot_mark(1);
	err = settings_subsys_init();
	if (err) {
		LOG_WRN("Settings mount failed (%d), erasing storage partition",
			err);
		app_boot_mark(2);
		err = storage_partition_erase();
		if (!err) {
			err = settings_subsys_init();
		}
		if (err) {
			LOG_ERR("Settings storage unrecoverable (%d)", err);
			app_boot_error_settings();
		}
		LOG_INF("Settings storage repaired");
	}

	err = bt_enable(NULL);
	if (err) {
		LOG_ERR("Bluetooth init failed (%d)", err);
		app_boot_error_bt();
	}
	app_boot_stage(3);

	if (IS_ENABLED(CONFIG_BT_SETTINGS)) {
		settings_load();
	}
	app_boot_stage(4);

	start_advertising();
	app_boot_stage(5);
	return 0;
}
