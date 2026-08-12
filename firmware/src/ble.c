/* Voice Keyboard — BLE peripheral.
 *
 * NUS-compatible GATT service (standard Nordic UART UUIDs) with encrypted
 * RX writes, LE bonding with a 60 s pairing window after a button press,
 * and bond persistence via the settings subsystem. v3 adds a config
 * characteristic (custom 128-bit UUID) for a user-settable, settings-
 * persisted device name. v5 adds the MACRO_LIST/MACRO_RW characteristics
 * (dongle-stored macros, see macro.c). See PROTOCOL.md.
 */

#include <zephyr/kernel.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/settings/settings.h>
#include <zephyr/storage/flash_map.h>

#include <zephyr/logging/log.h>
LOG_MODULE_REGISTER(ble, LOG_LEVEL_INF);

#include "vkb.h"

/* Zephyr keeps settings_subsys_init() out of the public headers
 * (subsys/settings/src/settings_init.c). bt_enable() calls it internally
 * via bt_settings_init(); declared here so ble_init() can mount the
 * settings backend first — see ble_init().
 */
extern int settings_subsys_init(void);

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
/* v3 config characteristic: user-settable device name (see PROTOCOL.md). */
#define VKB_UUID_CONFIG \
	BT_UUID_DECLARE_128(BT_UUID_128_ENCODE(0x5a1b0001, 0x8c4d, 0x4e2f, 0x9a3b, 0x7c6d5e4f3a2b))
/* v5 macro store characteristics (same vendor base as the config char). */
#define VKB_UUID_MACRO_LIST \
	BT_UUID_DECLARE_128(BT_UUID_128_ENCODE(0x5a1b0002, 0x8c4d, 0x4e2f, 0x9a3b, 0x7c6d5e4f3a2b))
#define VKB_UUID_MACRO_RW \
	BT_UUID_DECLARE_128(BT_UUID_128_ENCODE(0x5a1b0003, 0x8c4d, 0x4e2f, 0x9a3b, 0x7c6d5e4f3a2b))

#define DEVICE_NAME_MAX		20	/* protocol limit: 1..20 printable ASCII */
#define DEVICE_NAME_DEFAULT	"VoiceKB"

static struct bt_conn *current_conn;
static bool tx_notif_enabled;
static bool pairing_window_open;

/* Current advertising/GAP name; NUL-terminated, length device_name_len. */
static char device_name[DEVICE_NAME_MAX + 1] = DEVICE_NAME_DEFAULT;
static uint8_t device_name_len = sizeof(DEVICE_NAME_DEFAULT) - 1;

static ssize_t nus_rx_write(struct bt_conn *conn,
			    const struct bt_gatt_attr *attr,
			    const void *buf, uint16_t len,
			    uint16_t offset, uint8_t flags)
{
	ARG_UNUSED(conn); ARG_UNUSED(attr); ARG_UNUSED(offset); ARG_UNUSED(flags);

	app_led_debug(APP_LED_RX_WRITE);
	typing_feed(buf, len);
	return len;
}

static void nus_tx_ccc_changed(const struct bt_gatt_attr *attr, uint16_t value)
{
	ARG_UNUSED(attr);

	tx_notif_enabled = (value == BT_GATT_CCC_NOTIFY);
	if (tx_notif_enabled) {
		app_led_debug(APP_LED_TX_SUB);
		/* Queue an initial idle status: a central that waits for a
		 * status byte before its first RX write would otherwise
		 * block forever (statuses were only sent after writes).
		 */
		ble_notify_status(0x00);
	}
}

/* --- v3 config characteristic: user-settable device name --- */

static bool device_name_valid(const uint8_t *buf, uint16_t len)
{
	if (len < 1 || len > DEVICE_NAME_MAX) {
		return false;
	}
	for (uint16_t i = 0; i < len; i++) {
		if (buf[i] < 0x20 || buf[i] > 0x7e) { /* printable ASCII only */
			return false;
		}
	}
	return true;
}

static void start_advertising(void);

/* Apply device_name to the GAP name and, when not connected, to the
 * advertising data immediately. While connected (the normal case for a
 * config write) advertising is stopped anyway; the new name is picked up
 * by the re-advertise on disconnect.
 */
static void apply_device_name(void)
{
	if (IS_ENABLED(CONFIG_BT_DEVICE_NAME_DYNAMIC)) {
		int err = bt_set_name(device_name);

		if (err) {
			LOG_WRN("bt_set_name failed (%d)", err);
		}
	}
	if (!current_conn) {
		bt_le_adv_stop();
		start_advertising();
	}
}

static ssize_t config_read(struct bt_conn *conn,
			   const struct bt_gatt_attr *attr,
			   void *buf, uint16_t len, uint16_t offset)
{
	app_led_debug(APP_LED_NAME_READ);
	return bt_gatt_attr_read(conn, attr, buf, len, offset,
				 device_name, device_name_len);
}

static ssize_t config_write(struct bt_conn *conn,
			    const struct bt_gatt_attr *attr,
			    const void *buf, uint16_t len,
			    uint16_t offset, uint8_t flags)
{
	ARG_UNUSED(conn); ARG_UNUSED(attr); ARG_UNUSED(flags);

	if (offset != 0) {
		return BT_GATT_ERR(BT_ATT_ERR_INVALID_OFFSET);
	}
	if (!device_name_valid(buf, len)) {
		LOG_WRN("Rejected invalid device name (len %u)", len);
		return BT_GATT_ERR(BT_ATT_ERR_VALUE_NOT_ALLOWED);
	}

	memcpy(device_name, buf, len);
	device_name[len] = '\0';
	device_name_len = len;
	LOG_INF("Device name set to \"%s\"", device_name);

	int err = settings_save_one("vkb/name", device_name, device_name_len);

	if (err) {
		LOG_ERR("Failed to persist device name (%d)", err);
	}
	apply_device_name();
	return len;
}

/* Settings handler: restores the persisted name ("vkb/name") at boot. */
static int vkb_settings_set(const char *key, size_t len,
			    settings_read_cb read_cb, void *cb_arg)
{
	if (strcmp(key, "name") != 0) {
		return -ENOENT;
	}
	if (len > DEVICE_NAME_MAX) {
		return -EINVAL;
	}

	uint8_t buf[DEVICE_NAME_MAX];
	ssize_t n = read_cb(cb_arg, buf, len);

	if (n < 0 || !device_name_valid(buf, n)) {
		LOG_WRN("Ignoring invalid persisted device name");
		return 0;
	}
	memcpy(device_name, buf, n);
	device_name[n] = '\0';
	device_name_len = n;
	LOG_INF("Restored device name \"%s\"", device_name);
	return 0;
}

SETTINGS_STATIC_HANDLER_DEFINE(vkb, "vkb", NULL, vkb_settings_set, NULL, NULL);

/* --- v5 macro store characteristics (logic lives in macro.c) --- */

static ssize_t macro_list_read(struct bt_conn *conn,
			       const struct bt_gatt_attr *attr,
			       void *buf, uint16_t len, uint16_t offset)
{
	uint16_t json_len;
	const uint8_t *json = macro_list_json(&json_len);

	return bt_gatt_attr_read(conn, attr, buf, len, offset, json, json_len);
}

static ssize_t macro_rw_read(struct bt_conn *conn,
			     const struct bt_gatt_attr *attr,
			     void *buf, uint16_t len, uint16_t offset)
{
	uint16_t resp_len;
	const uint8_t *resp = macro_get_response(&resp_len);

	return bt_gatt_attr_read(conn, attr, buf, len, offset, resp, resp_len);
}

static ssize_t macro_rw_write(struct bt_conn *conn,
			      const struct bt_gatt_attr *attr,
			      const void *buf, uint16_t len,
			      uint16_t offset, uint8_t flags)
{
	ARG_UNUSED(conn); ARG_UNUSED(attr); ARG_UNUSED(flags);

	if (offset != 0) {
		return BT_GATT_ERR(BT_ATT_ERR_INVALID_OFFSET);
	}

	int err = macro_write(buf, len);

	return err ? BT_GATT_ERR(-err) : len;
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
	BT_GATT_CHARACTERISTIC(VKB_UUID_CONFIG,
		BT_GATT_CHRC_READ | BT_GATT_CHRC_WRITE,
		BT_GATT_PERM_READ_ENCRYPT | BT_GATT_PERM_WRITE_ENCRYPT,
		config_read, config_write, NULL),
	BT_GATT_CHARACTERISTIC(VKB_UUID_MACRO_LIST,
		BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY,
		BT_GATT_PERM_READ_ENCRYPT,
		macro_list_read, NULL, NULL),
	BT_GATT_CCC(NULL, BT_GATT_PERM_READ_ENCRYPT | BT_GATT_PERM_WRITE_ENCRYPT),
	BT_GATT_CHARACTERISTIC(VKB_UUID_MACRO_RW,
		BT_GATT_CHRC_READ | BT_GATT_CHRC_WRITE,
		BT_GATT_PERM_READ_ENCRYPT | BT_GATT_PERM_WRITE_ENCRYPT,
		macro_rw_read, macro_rw_write, NULL),
);

/* Advertising data is rebuilt from device_name on every (re)start, so a
 * name set via the config characteristic shows up in the next advertise.
 */
static struct bt_data ad[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR),
	{
		.type = BT_DATA_NAME_COMPLETE,
		.data_len = 0, /* set from device_name_len in start_advertising() */
		.data = (const uint8_t *)device_name,
	},
};

static const struct bt_data sd[] = {
	BT_DATA_BYTES(BT_DATA_UUID128_ALL,
		      BT_UUID_128_ENCODE(0x6e400001, 0xb5a3, 0xf393,
					 0xe0a9, 0xe50e24dcca9e)),
};

static void start_advertising(void)
{
	ad[1].data_len = device_name_len;

	int err = bt_le_adv_start(BT_LE_ADV_CONN_FAST_2, ad, ARRAY_SIZE(ad),
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

static void bond_count_cb(const struct bt_bond_info *info, void *user_data)
{
	ARG_UNUSED(info);

	(*(int *)user_data)++;
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
		app_led_debug(APP_LED_CONN_REJECT);
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
	macro_abort_put();
	start_advertising();
}

static void security_changed(struct bt_conn *conn, bt_security_t level,
			     enum bt_security_err err)
{
	if (err) {
		LOG_ERR("Security failed: level %u err %d", level, err);
		app_led_debug(APP_LED_SEC_FAIL);
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

/* --- Notifications ---------------------------------------------------------
 *
 * bt_gatt_notify() must never run on the BT RX thread (GATT write/CCC
 * callbacks included): for a notification it allocates a PDU from att_pool
 * (CONFIG_BT_ATT_TX_COUNT=3 here) with K_FOREVER unless the caller is the
 * system workqueue (Zephyr 4.1 att.c bt_att_chan_create_pdu()), and those
 * buffers are freed by ATT TX completion processing on that same RX thread.
 * A notify from inside a callback can therefore block the RX thread forever
 * and kill the whole ATT server — the v5.3 hang right after TX subscribe
 * (9 blinks, solid green, config read never answered). All notifications
 * are deferred to the system workqueue, where the allocation is K_NO_WAIT
 * and the worst case is a dropped (best-effort) byte.
 *
 * nus_svc attribute layout:
 *   attrs[0] primary service, attrs[1] TX declaration,
 *   attrs[2] TX value, attrs[3] TX CCC,
 *   attrs[4] RX declaration, attrs[5] RX value,
 *   attrs[6] config declaration, attrs[7] config value (v3),
 *   attrs[8] MACRO_LIST declaration, attrs[9] MACRO_LIST value,
 *   attrs[10] MACRO_LIST CCC (v5),
 *   attrs[11] MACRO_RW declaration, attrs[12] MACRO_RW value (v5).
 * Notifications must be sent on the VALUE attribute (attrs[2]); using
 * attrs[1] notifies the declaration handle, which no central subscribes to,
 * so every status byte is silently dropped.
 */

static uint8_t pending_status;
static bool status_pending;

static void status_notify_work_fn(struct k_work *work);

static K_WORK_DEFINE(status_notify_work, status_notify_work_fn);

static void status_notify_work_fn(struct k_work *work)
{
	ARG_UNUSED(work);

	if (!status_pending || !current_conn || !tx_notif_enabled) {
		return;
	}

	uint8_t status = pending_status;

	status_pending = false;

	int err = bt_gatt_notify(current_conn, &nus_svc.attrs[2],
				 &status, sizeof(status));

	if (err) {
		LOG_WRN("Status notify failed (%d)", err);
	}
}

/* Queues the status; the actual notify runs on the system workqueue. */
void ble_notify_status(uint8_t status)
{
	pending_status = status;
	status_pending = true;
	k_work_submit(&status_notify_work);
}

bool ble_is_connected(void)
{
	return current_conn != NULL;
}

static void macro_list_notify_work_fn(struct k_work *work);

static K_WORK_DEFINE(macro_list_notify_work, macro_list_notify_work_fn);

static void macro_list_notify_work_fn(struct k_work *work)
{
	ARG_UNUSED(work);

	if (!current_conn) {
		return;
	}

	/* The list is rebuilt at send time, so the notification always
	 * reflects the latest store state no matter when the work runs.
	 */
	uint16_t len;
	const uint8_t *json = macro_list_json(&len);

	/* MACRO_LIST value attribute (see layout above). NULL conn notifies
	 * every peer that enabled the CCC. If the list outgrows the ATT MTU
	 * the notification is dropped (best effort); the list can always be
	 * read back from the characteristic itself.
	 */
	int err = bt_gatt_notify(NULL, &nus_svc.attrs[9], json, len);

	if (err) {
		LOG_WRN("MACRO_LIST notify failed (%d)", err);
	}
}

/* Queues the notification; the actual notify runs on the system workqueue. */
void ble_notify_macro_list(void)
{
	k_work_submit(&macro_list_notify_work);
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
	 * older firmware could legally occupy (v4 allowed app images up to
	 * 0xF4000) or that may carry DFU residue. bt_enable() ->
	 * bt_init() -> bt_settings_init() mounts NVS on it and ABORTS
	 * bt_enable() on any mount error (garbage flash: -EDEADLK, since
	 * CONFIG_NVS_INIT_BAD_MEMORY_REGION=n) — the boot then dies at
	 * stage 2 with no BLE (observed on v5/v5.1 hardware). Mount it
	 * ourselves first; on failure erase the partition and retry, so
	 * the mount always sees a valid (empty) NVS. A repair erase loses
	 * bonds/name: re-pair once.
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
	/* Assemble settings-restored macro chunks (no-op when none). */
	macro_boot_finalize();
	app_boot_stage(4);

	/* Reflect the (possibly settings-restored) name in the GAP Device
	 * Name characteristic; advertising data picks it up below.
	 */
	if (IS_ENABLED(CONFIG_BT_DEVICE_NAME_DYNAMIC)) {
		bt_set_name(device_name);
	}

	bt_conn_auth_cb_register(&auth_cb);

	/* Bondable only inside the pairing window. */
	bt_set_bondable(false);

	/* A dongle with zero stored bonds can never be connected to: every
	 * peer is rejected by the bonded-peers gate in connected() until the
	 * physical button is pressed. That is the factory/repaired state
	 * (fresh flash, v5 partition move, v5.2 repair-erase) — open the
	 * pairing window once at boot so recovery never depends on button
	 * access. With at least one bond the window stays button-gated.
	 */
	int bond_count = 0;

	bt_foreach_bond(BT_ID_DEFAULT, bond_count_cb, &bond_count);
	if (bond_count == 0) {
		LOG_INF("No bonds stored: opening pairing window for recovery");
		ble_open_pairing_window();
	}

	start_advertising();
	app_boot_stage(5);
	return 0;
}
