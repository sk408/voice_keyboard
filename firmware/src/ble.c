/* Voice Keyboard — BLE peripheral.
 *
 * NUS-compatible GATT service (standard Nordic UART UUIDs) with encrypted
 * RX writes, LE bonding with a 60 s pairing window after a button press,
 * and bond persistence via the settings subsystem. See PROTOCOL.md.
 */

#include <zephyr/kernel.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/settings/settings.h>

#include <zephyr/logging/log.h>
LOG_MODULE_REGISTER(ble, LOG_LEVEL_INF);

#include "vkb.h"

#define PAIRING_WINDOW_SECONDS	60

/* Standard NUS UUIDs (we define the service in-app so that the RX
 * characteristic can require an encrypted link — Zephyr's built-in NUS
 * uses plain BT_GATT_PERM_WRITE).
 */
#define VKB_UUID_NUS_SERVICE \
	BT_UUID_DECLARE_128(BT_UUID_128_ENCODE(0x6e400001, 0xb5a3, 0xf393, 0xe0a9, 0xe50e24dcca9e))
#define VKB_UUID_NUS_RX \
	BT_UUID_DECLARE_128(BT_UUID_128_ENCODE(0x6e400002, 0xb5a3, 0xf393, 0xe0a9, 0xe50e24dcca9e))
#define VKB_UUID_NUS_TX \
	BT_UUID_DECLARE_128(BT_UUID_128_ENCODE(0x6e400003, 0xb5a3, 0xf393, 0xe0a9, 0xe50e24dcca9e))

static struct bt_conn *current_conn;
static bool tx_notif_enabled;
static bool pairing_window_open;

static ssize_t nus_rx_write(struct bt_conn *conn,
			    const struct bt_gatt_attr *attr,
			    const void *buf, uint16_t len,
			    uint16_t offset, uint8_t flags)
{
	ARG_UNUSED(conn); ARG_UNUSED(attr); ARG_UNUSED(offset); ARG_UNUSED(flags);

	typing_feed(buf, len);
	return len;
}

static void nus_tx_ccc_changed(const struct bt_gatt_attr *attr, uint16_t value)
{
	ARG_UNUSED(attr);

	tx_notif_enabled = (value == BT_GATT_CCC_NOTIFY);
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
		BT_GATT_PERM_WRITE_ENCRYPT,
		NULL, nus_rx_write, NULL),
);

static const struct bt_data ad[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR),
	BT_DATA(BT_DATA_NAME_COMPLETE, "VoiceKB", 7),
};

static const struct bt_data sd[] = {
	BT_DATA_BYTES(BT_DATA_UUID128_ALL,
		      BT_UUID_128_ENCODE(0x6e400001, 0xb5a3, 0xf393,
					 0xe0a9, 0xe50e24dcca9e)),
};

static void start_advertising(void)
{
	int err = bt_le_adv_start(BT_LE_ADV_CONN, ad, ARRAY_SIZE(ad),
				  sd, ARRAY_SIZE(sd));
	if (err) {
		LOG_ERR("Advertising failed to start (%d)", err);
		return;
	}

	app_led_advertising();
	LOG_INF("Advertising started");
}

/* --- Bonded-peer check (used to gate connections outside the window) --- */

struct bond_search {
	const bt_addr_le_t *addr;
	bool found;
};

static void bond_search_cb(const struct bt_bond_info *info, void *user_data)
{
	struct bond_search *search = user_data;

	if (bt_addr_le_cmp(&info->addr, search->addr) == 0) {
		search->found = true;
	}
}

static bool peer_is_bonded(struct bt_conn *conn)
{
	struct bond_search search = {
		.addr = bt_conn_get_dst(conn),
		.found = false,
	};

	bt_foreach_bond(BT_ID_DEFAULT, bond_search_cb, &search);
	return search.found;
}

/* --- Pairing window --- */

static void close_pairing_window(struct k_work *work);

static K_WORK_DEFINE(close_window_work, close_pairing_window);

static void pairing_window_expired(struct k_timer *timer)
{
	ARG_UNUSED(timer);

	/* Timer runs in ISR context; do the BT work from the workqueue. */
	k_work_submit(&close_window_work);
}

static K_TIMER_DEFINE(pairing_window_timer, pairing_window_expired, NULL);

static void close_pairing_window(struct k_work *work)
{
	ARG_UNUSED(work);

	pairing_window_open = false;
	bt_set_bondable(false);
	LOG_INF("Pairing window closed");

	if (current_conn && !peer_is_bonded(current_conn)) {
		LOG_INF("Disconnecting unbonded peer");
		bt_conn_disconnect(current_conn, BT_HCI_ERR_AUTH_FAIL);
	}
}

void ble_open_pairing_window(void)
{
	pairing_window_open = true;
	bt_set_bondable(true);
	k_timer_start(&pairing_window_timer,
		      K_SECONDS(PAIRING_WINDOW_SECONDS), K_NO_WAIT);
	LOG_INF("Pairing window open for %d s", PAIRING_WINDOW_SECONDS);
}

/* --- Connection management --- */

static void connected(struct bt_conn *conn, uint8_t err)
{
	if (err) {
		LOG_ERR("Connection failed (err 0x%02x)", err);
		return;
	}

	/* Outside the pairing window only bonded centrals may stay. */
	if (!pairing_window_open && !peer_is_bonded(conn)) {
		LOG_WRN("Rejecting unbonded peer (pairing window closed)");
		bt_conn_disconnect(conn, BT_HCI_ERR_AUTH_FAIL);
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
	typing_reset();
	start_advertising();
}

static void security_changed(struct bt_conn *conn, bt_security_t level,
			     enum bt_security_err err)
{
	if (err) {
		LOG_ERR("Security failed: level %u err %d", level, err);
	} else {
		LOG_INF("Security changed: level %u", level);
	}
}

BT_CONN_CB_DEFINE(conn_cbs) = {
	.connected = connected,
	.disconnected = disconnected,
	.security_changed = security_changed,
};

/* No input/output capabilities -> Just Works pairing. */
static void auth_cancel(struct bt_conn *conn)
{
	ARG_UNUSED(conn);
	LOG_INF("Pairing cancelled");
}

static struct bt_conn_auth_cb auth_cb = {
	.cancel = auth_cancel,
};

void ble_notify_status(uint8_t status)
{
	if (!current_conn || !tx_notif_enabled) {
		return;
	}

	/* attrs[1] is the TX characteristic value attribute. */
	bt_gatt_notify(current_conn, &nus_svc.attrs[1], &status, sizeof(status));
}

int ble_init(void)
{
	int err;

	err = bt_enable(NULL);
	if (err) {
		LOG_ERR("Bluetooth init failed (%d)", err);
		return err;
	}

	if (IS_ENABLED(CONFIG_BT_SETTINGS)) {
		settings_load();
	}

	bt_conn_auth_cb_register(&auth_cb);

	/* Bondable only inside the pairing window. */
	bt_set_bondable(false);

	start_advertising();
	return 0;
}
