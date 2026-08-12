/* Voice Keyboard — v5 dongle-stored macros.
 *
 * Settings/NVS-backed store of 16 macro slots under a 16 KB total budget
 * (see README.md). Each slot: name (<=24 bytes) + template bytes — an
 * arbitrary pre-encoded byte stream (UTF-8 text + 0x00 escape tokens) that
 * is played back through the same typing-engine path as NUS RX bytes.
 *
 * Persistence uses the settings subtree "vkbm": per slot a name key
 * "vkbm/<i>/n" and template chunk keys "vkbm/<i>/t/<k>". Chunks are needed
 * because one NVS record is limited to roughly a flash sector (4 KB), far
 * below the 16 KB store budget; each chunk is MACRO_NVS_CHUNK bytes (all but
 * the last). The whole store is mirrored in RAM (assembled by
 * macro_boot_finalize() after settings_load()).
 *
 * The chunked GATT protocol (MACRO_RW characteristic) is driven from thin
 * wrappers in ble.c: macro_write() for writes, macro_get_response() for
 * reads, macro_list_json() for the MACRO_LIST value. JSON is parsed with a
 * minimal hand-rolled object walker (the client sends a fixed shape) and
 * the "data" field is unescaped purely at the byte level: printable ASCII
 * passes through, \u00XX (and defensively \xXX) decodes to a raw byte, plus
 * the standard JSON escapes. Chunk boundaries may fall anywhere in the byte
 * stream; bytes are appended to the staging buffer without interpretation.
 */

#include <zephyr/kernel.h>
#include <zephyr/settings/settings.h>
#include <zephyr/bluetooth/att.h>

#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#include <zephyr/logging/log.h>
LOG_MODULE_REGISTER(macro, LOG_LEVEL_INF);

#include "vkb.h"

#define MACRO_SLOTS		16
#define MACRO_NAME_MAX		24
#define MACRO_STORE_MAX		(16 * 1024)	/* total budget, all slots */

/* NVS holds one record per template chunk: a record must fit (with its key)
 * into a 4 KB flash sector, so 2 KB chunks are comfortably safe. */
#define MACRO_NVS_CHUNK		2048
#define MACRO_NVS_CHUNKS_MAX	(MACRO_STORE_MAX / MACRO_NVS_CHUNK)

/* A put chunk arrives as one ATT write (spec: <=180 bytes of JSON), so the
 * decoded data can never exceed the raw write length. Allow larger writes
 * than the spec minimum without rejecting them.
 */
#define MACRO_CHUNK_MAX		512

/* Keep the get response within a standard ATT payload (<=180 bytes). */
#define MACRO_GET_RESP_MAX	180

struct macro_slot {
	bool used;
	uint8_t name_len;
	uint16_t off;		/* template offset in arena */
	uint16_t len;		/* template length */
	char name[MACRO_NAME_MAX];
};

static struct macro_slot slots[MACRO_SLOTS];
static uint8_t arena[MACRO_STORE_MAX];
static uint16_t arena_used;

/* Put staging: template bytes accumulate here until the "fin" chunk. */
static uint8_t staging[MACRO_STORE_MAX];
static bool put_active;
static uint8_t put_i;
static uint16_t put_len;
static uint8_t put_name_len;
static char put_name[MACRO_NAME_MAX];

/* Snapshot for playback (button trigger): copied under the lock, then fed
 * to the typing engine unlocked so a long macro never blocks GATT access.
 */
static uint8_t play_buf[MACRO_STORE_MAX];

static K_MUTEX_DEFINE(store_lock);

/* --- budget accounting ------------------------------------------------- */

/* Logical per-slot cost: mirrors the persisted footprint (name + template,
 * plus a byte of overhead). Sum over all slots must stay <= MACRO_STORE_MAX.
 */
static uint32_t slot_cost(const struct macro_slot *s)
{
	return 1 + s->name_len + s->len;
}

static uint32_t store_used(void)
{
	uint32_t used = 0;

	for (int i = 0; i < MACRO_SLOTS; i++) {
		if (slots[i].used) {
			used += slot_cost(&slots[i]);
		}
	}
	return used;
}

/* --- arena management ---------------------------------------------------- */

/* Remove slot i's template from the arena, compacting the rest. */
static void arena_remove(int i)
{
	struct macro_slot *s = &slots[i];

	if (!s->used) {
		return;
	}
	memmove(&arena[s->off], &arena[s->off + s->len],
		arena_used - (s->off + s->len));
	for (int j = 0; j < MACRO_SLOTS; j++) {
		if (slots[j].used && slots[j].off > s->off) {
			slots[j].off -= s->len;
		}
	}
	arena_used -= s->len;
	s->used = false;
	s->len = 0;
}

/* Append len template bytes to the arena and attach them to slot i.
 * Caller must have checked the budget; arena_used + len <= MACRO_STORE_MAX
 * follows from it because each arena byte is covered by slot_cost().
 */
static void arena_append(int i, const uint8_t *data, uint16_t len)
{
	struct macro_slot *s = &slots[i];

	memcpy(&arena[arena_used], data, len);
	s->off = arena_used;
	s->len = len;
	s->used = true;
	arena_used += len;
}

/* --- MACRO_LIST JSON ----------------------------------------------------- */

/* Worst case per entry: {"i":15,"name":"","len":16384}, is ~31 chars plus
 * the name at up to 6 chars per byte (every byte escaped as \u00XX).
 */
static char list_json[MACRO_SLOTS * (MACRO_NAME_MAX * 6 + 32) + 4];
static uint16_t list_json_len;

/* Append name JSON-escaped to out; never writes past out_max (including the
 * \0 snprintf needs). Truncation cannot happen with a correctly sized
 * list_json, but stay bounded regardless.
 */
static size_t json_escape_name(char *out, size_t out_max, const char *name,
			       uint8_t len)
{
	size_t n = 0;

	for (uint8_t i = 0; i < len; i++) {
		uint8_t c = name[i];

		if (c == '"' || c == '\\') {
			if (n + 2 > out_max) {
				break;
			}
			out[n++] = '\\';
			out[n++] = c;
		} else if (c >= 0x20 && c <= 0x7e) {
			if (n + 1 > out_max) {
				break;
			}
			out[n++] = c;
		} else {
			if (out_max - n < 7) { /* "\u00XX" + \0 */
				break;
			}
			n += snprintf(&out[n], 7, "\\u%04x", c);
		}
	}
	return n;
}

/* Rebuild the MACRO_LIST value, e.g. [{"i":0,"name":"SOAP note","len":412}].
 * Must be called with store_lock held.
 */
static void list_json_rebuild(void)
{
	size_t n = 0;

	list_json[n++] = '[';
	for (int i = 0; i < MACRO_SLOTS; i++) {
		struct macro_slot *s = &slots[i];

		if (!s->used) {
			continue;
		}
		n += snprintf(&list_json[n], sizeof(list_json) - n,
			      "%s{\"i\":%d,\"name\":\"", n > 1 ? "," : "", i);
		n += json_escape_name(&list_json[n], sizeof(list_json) - n - 16,
				      s->name, s->name_len);
		n += snprintf(&list_json[n], sizeof(list_json) - n,
			      "\",\"len\":%u}", s->len);
	}
	list_json[n++] = ']';
	list_json[n] = '\0';
	list_json_len = n;
}

const uint8_t *macro_list_json(uint16_t *len)
{
	k_mutex_lock(&store_lock, K_FOREVER);
	list_json_rebuild();
	k_mutex_unlock(&store_lock);
	*len = list_json_len;
	return (const uint8_t *)list_json;
}

/* Queue a store-changed notification for subscribed centrals. Caller holds
 * no lock; the JSON is rebuilt in ble.c when the deferred notify runs.
 */
static void notify_list_changed(void)
{
	ble_notify_macro_list();
}

/* --- minimal JSON object walker -------------------------------------------
 *
 * Parses a flat object {"key":value,...} where values are strings, integers
 * or true/false — the fixed shape the client sends. String values are
 * unescaped at the byte level (never as UTF-8): \" \\ \/ \b \f \n \r \t,
 * \uXXXX (low byte kept; the client emits \u00XX per raw byte) and,
 * defensively, \xXX. Any other byte — including raw bytes >= 0x80 — passes
 * through unchanged.
 */

struct json_parser {
	const uint8_t *p;
	const uint8_t *end;
};

static void json_skip_ws(struct json_parser *jp)
{
	while (jp->p < jp->end &&
	       (*jp->p == ' ' || *jp->p == '\t' || *jp->p == '\n' || *jp->p == '\r')) {
		jp->p++;
	}
}

static int hex_val(uint8_t c)
{
	if (c >= '0' && c <= '9') {
		return c - '0';
	}
	if (c >= 'a' && c <= 'f') {
		return c - 'a' + 10;
	}
	if (c >= 'A' && c <= 'F') {
		return c - 'A' + 10;
	}
	return -1;
}

/* Unescape one escape sequence (p points past the backslash). */
static bool json_unescape(struct json_parser *jp, uint8_t *out)
{
	if (jp->p >= jp->end) {
		return false;
	}

	uint8_t c = *jp->p++;

	switch (c) {
	case '"': *out = '"'; return true;
	case '\\': *out = '\\'; return true;
	case '/': *out = '/'; return true;
	case 'b': *out = 0x08; return true;
	case 'f': *out = 0x0c; return true;
	case 'n': *out = '\n'; return true;
	case 'r': *out = '\r'; return true;
	case 't': *out = '\t'; return true;
	case 'x': { /* non-standard \xXX, accepted defensively */
		if (jp->end - jp->p < 2) {
			return false;
		}
		int hi = hex_val(jp->p[0]), lo = hex_val(jp->p[1]);

		if (hi < 0 || lo < 0) {
			return false;
		}
		*out = (hi << 4) | lo;
		jp->p += 2;
		return true;
	}
	case 'u': { /* \u00XX: one raw byte per escape (client contract) */
		if (jp->end - jp->p < 4) {
			return false;
		}
		int v = 0;

		for (int k = 0; k < 4; k++) {
			int d = hex_val(jp->p[k]);

			if (d < 0) {
				return false;
			}
			v = (v << 4) | d;
		}
		*out = (uint8_t)v; /* byte stream: keep the low byte */
		jp->p += 4;
		return true;
	}
	default:
		return false;
	}
}

/* Parse a string value into raw bytes. p must be at the opening quote. */
static int json_string(struct json_parser *jp, uint8_t *out, uint16_t out_max)
{
	uint16_t n = 0;

	if (jp->p >= jp->end || *jp->p != '"') {
		return -1;
	}
	jp->p++;

	while (jp->p < jp->end && *jp->p != '"') {
		uint8_t c;

		if (*jp->p == '\\') {
			jp->p++;
			if (!json_unescape(jp, &c)) {
				return -1;
			}
		} else {
			c = *jp->p++;
		}
		if (out != NULL) {
			if (n >= out_max) {
				return -1;
			}
			out[n] = c;
		}
		n++;
	}
	if (jp->p >= jp->end) { /* unterminated */
		return -1;
	}
	jp->p++; /* closing quote */
	return n;
}

static bool json_uint(struct json_parser *jp, uint32_t *out)
{
	uint32_t v = 0;
	bool any = false;

	json_skip_ws(jp);
	while (jp->p < jp->end && *jp->p >= '0' && *jp->p <= '9') {
		v = v * 10 + (*jp->p++ - '0');
		if (v > 1000000) { /* far beyond any valid off/len */
			return false;
		}
		any = true;
	}
	if (!any) {
		return false;
	}
	*out = v;
	return true;
}

static bool json_bool(struct json_parser *jp, bool *out)
{
	json_skip_ws(jp);
	if (jp->end - jp->p >= 4 && memcmp(jp->p, "true", 4) == 0) {
		jp->p += 4;
		*out = true;
		return true;
	}
	if (jp->end - jp->p >= 5 && memcmp(jp->p, "false", 5) == 0) {
		jp->p += 5;
		*out = false;
		return true;
	}
	return false;
}

/* --- MACRO_RW request ------------------------------------------------------ */

struct macro_req {
	char op[8];				/* "put" / "del" / "get" */
	bool have_i;
	uint32_t i;
	bool have_name;
	uint8_t name_len;
	uint8_t name[MACRO_NAME_MAX];
	bool have_off;
	uint32_t off;
	bool have_data;
	uint16_t data_len;
	uint8_t data[MACRO_CHUNK_MAX];
	bool fin;
};

/* Parse one MACRO_RW write. Returns 0 on success, -1 on malformed JSON. */
static int macro_req_parse(const uint8_t *buf, uint16_t len, struct macro_req *req)
{
	struct json_parser jp = { .p = buf, .end = buf + len };

	memset(req, 0, sizeof(*req));

	json_skip_ws(&jp);
	if (jp.p >= jp.end || *jp.p != '{') {
		return -1;
	}
	jp.p++;

	while (true) {
		uint8_t key[8];
		int klen;

		json_skip_ws(&jp);
		klen = json_string(&jp, key, sizeof(key));
		if (klen < 0) {
			return -1;
		}
		json_skip_ws(&jp);
		if (jp.p >= jp.end || *jp.p != ':') {
			return -1;
		}
		jp.p++;
		json_skip_ws(&jp);

		if (klen == 2 && memcmp(key, "op", 2) == 0) {
			uint8_t op[sizeof(req->op)];
			int n = json_string(&jp, op, sizeof(op) - 1);

			if (n < 0) {
				return -1;
			}
			memcpy(req->op, op, n);
			req->op[n] = '\0';
		} else if (klen == 1 && key[0] == 'i') {
			req->have_i = json_uint(&jp, &req->i);
			if (!req->have_i) {
				return -1;
			}
		} else if (klen == 4 && memcmp(key, "name", 4) == 0) {
			int n = json_string(&jp, req->name, MACRO_NAME_MAX);

			if (n < 0) {
				return -1;
			}
			req->name_len = n;
			req->have_name = true;
		} else if (klen == 3 && memcmp(key, "off", 3) == 0) {
			req->have_off = json_uint(&jp, &req->off);
			if (!req->have_off) {
				return -1;
			}
		} else if (klen == 4 && memcmp(key, "data", 4) == 0) {
			int n = json_string(&jp, req->data, sizeof(req->data));

			if (n < 0) {
				return -1;
			}
			req->data_len = n;
			req->have_data = true;
		} else if (klen == 3 && memcmp(key, "fin", 3) == 0) {
			if (!json_bool(&jp, &req->fin)) {
				return -1;
			}
		} else {
			return -1; /* unknown key: fixed shape, be strict */
		}

		json_skip_ws(&jp);
		if (jp.p < jp.end && *jp.p == ',') {
			jp.p++;
			continue;
		}
		if (jp.p < jp.end && *jp.p == '}') {
			jp.p++;
			json_skip_ws(&jp);
			return jp.p == jp.end ? 0 : -1;
		}
		return -1;
	}
}

/* --- put / del / get -------------------------------------------------------- */

/* Get response staged by the last "get" write; "{}" until the first one. */
static char get_resp[MACRO_GET_RESP_MAX + 8] = "{}";
static uint16_t get_resp_len = 2;

void macro_abort_put(void)
{
	k_mutex_lock(&store_lock, K_FOREVER);
	if (put_active) {
		LOG_INF("Put aborted (slot %u, %u bytes staged)", put_i, put_len);
		put_active = false;
	}
	/* Also drop the staged get response: a read must only ever return a
	 * response prepared by a get on the same connection.
	 */
	memcpy(get_resp, "{}", 2);
	get_resp_len = 2;
	k_mutex_unlock(&store_lock);
}

static uint16_t chunks_for(uint16_t len)
{
	return (len + MACRO_NVS_CHUNK - 1) / MACRO_NVS_CHUNK;
}

/* Delete slot i's persisted keys and free its arena range.
 * Caller holds store_lock.
 */
static void slot_delete(uint8_t i)
{
	char key[16];

	for (uint16_t k = 0; k < chunks_for(slots[i].len); k++) {
		snprintk(key, sizeof(key), "vkbm/%u/t/%u", i, k);
		settings_delete(key);
	}
	snprintk(key, sizeof(key), "vkbm/%u/n", i);
	settings_delete(key);

	arena_remove(i);
	slots[i].name_len = 0;
	LOG_INF("Macro %u deleted (store %u/%u)", i, store_used(), MACRO_STORE_MAX);
}

/* Commit a finished put: persist first, then update the in-RAM store.
 * Caller holds store_lock; put_len > 0 (an empty put deletes the slot).
 */
static int put_commit(void)
{
	char key[16];
	int err;
	uint16_t old_chunks = chunks_for(slots[put_i].used ? slots[put_i].len : 0);
	uint16_t new_chunks = chunks_for(put_len);

	for (uint16_t k = 0; k < new_chunks; k++) {
		uint16_t clen = MIN(MACRO_NVS_CHUNK, put_len - k * MACRO_NVS_CHUNK);

		snprintk(key, sizeof(key), "vkbm/%u/t/%u", put_i, k);
		err = settings_save_one(key, &staging[k * MACRO_NVS_CHUNK], clen);
		if (err) {
			LOG_ERR("Failed to persist macro %u chunk %u (%d)", put_i, k, err);
			while (k-- > 0) { /* best-effort rollback */
				snprintk(key, sizeof(key), "vkbm/%u/t/%u", put_i, k);
				settings_delete(key);
			}
			return err;
		}
	}

	snprintk(key, sizeof(key), "vkbm/%u/n", put_i);
	err = settings_save_one(key, put_name, put_name_len);
	if (err) {
		LOG_ERR("Failed to persist macro %u name (%d)", put_i, err);
		return err;
	}

	/* Drop chunks left over from a previously longer template. */
	for (uint16_t k = new_chunks; k < old_chunks; k++) {
		snprintk(key, sizeof(key), "vkbm/%u/t/%u", put_i, k);
		settings_delete(key);
	}

	arena_remove(put_i);
	arena_append(put_i, staging, put_len);
	slots[put_i].name_len = put_name_len;
	memcpy(slots[put_i].name, put_name, put_name_len);
	LOG_INF("Macro %u stored: \"%.*s\", %u bytes (store %u/%u)",
		put_i, put_name_len, put_name, put_len,
		store_used(), MACRO_STORE_MAX);
	return 0;
}

static int handle_put(const struct macro_req *req)
{
	if (!req->have_i || req->i >= MACRO_SLOTS || !req->have_off) {
		return -EINVAL;
	}

	k_mutex_lock(&store_lock, K_FOREVER);

	if (req->off == 0) {
		/* First chunk (also restarts an interrupted put). */
		if (!req->have_name) {
			k_mutex_unlock(&store_lock);
			return -EINVAL;
		}
		put_active = true;
		put_i = req->i;
		put_len = 0;
		put_name_len = req->name_len;
		memcpy(put_name, req->name, req->name_len);
	} else {
		if (!put_active || req->i != put_i || req->off != put_len) {
			LOG_WRN("Put chunk out of sequence (off %u, staged %u)",
				req->off, put_len);
			k_mutex_unlock(&store_lock);
			return -EINVAL;
		}
	}

	/* Budget: committed store minus the slot being replaced, plus the
	 * staged name and template, must stay within MACRO_STORE_MAX.
	 */
	uint32_t used = store_used();
	uint32_t new_cost = 1 + put_name_len + put_len + req->data_len;

	if (slots[put_i].used) {
		used -= slot_cost(&slots[put_i]);
	}
	if (used + new_cost > MACRO_STORE_MAX) {
		LOG_WRN("Macro store full (%u + %u > %u)",
			used, new_cost, MACRO_STORE_MAX);
		put_active = false;
		k_mutex_unlock(&store_lock);
		ble_notify_status(VKB_TX_ERR_STORE_FULL);
		return -ENOSPC;
	}

	memcpy(&staging[put_len], req->data, req->data_len);
	put_len += req->data_len;

	if (req->fin) {
		put_active = false;
		if (put_len == 0) {
			/* An empty template stores nothing: delete the slot. */
			if (slots[put_i].used) {
				slot_delete(put_i);
			}
			k_mutex_unlock(&store_lock);
			notify_list_changed();
			return 0;
		}
		int err = put_commit();

		k_mutex_unlock(&store_lock);
		if (err) {
			ble_notify_status(VKB_TX_ERR_STORE_FULL);
			return -EIO;
		}
		notify_list_changed();
		return 0;
	}

	k_mutex_unlock(&store_lock);
	return 0;
}

static int handle_del(const struct macro_req *req)
{
	if (!req->have_i || req->i >= MACRO_SLOTS) {
		return -EINVAL;
	}

	k_mutex_lock(&store_lock, K_FOREVER);

	if (!slots[req->i].used) {
		k_mutex_unlock(&store_lock);
		return 0; /* deleting an empty slot is a no-op */
	}

	slot_delete(req->i);

	k_mutex_unlock(&store_lock);
	notify_list_changed();
	return 0;
}

/* --- get (read-back) --------------------------------------------------------- */

static int handle_get(const struct macro_req *req)
{
	if (!req->have_i || req->i >= MACRO_SLOTS) {
		return -EINVAL;
	}

	k_mutex_lock(&store_lock, K_FOREVER);

	struct macro_slot *s = &slots[req->i];
	uint32_t off = req->have_off ? req->off : 0;
	size_t n;

	if (!s->used || off > s->len) {
		k_mutex_unlock(&store_lock);
		return -EINVAL;
	}

	n = snprintk(get_resp, sizeof(get_resp), "{\"op\":\"get\",\"i\":%u,\"off\":%u,\"len\":%u,\"data\":\"",
		     req->i, off, s->len);

	/* Escape template bytes into the data field, stopping before the
	 * response would exceed MACRO_GET_RESP_MAX (leave room for the
	 * closing quote, optional "fin" and brace).
	 */
	uint32_t pos = off;

	while (pos < s->len) {
		uint8_t c = arena[s->off + pos];
		char esc[8];
		uint8_t elen;

		if (c == '"' || c == '\\') {
			esc[0] = '\\';
			esc[1] = c;
			elen = 2;
		} else if (c >= 0x20 && c <= 0x7e) {
			esc[0] = c;
			elen = 1;
		} else {
			snprintk(esc, sizeof(esc), "\\u%04x", c);
			elen = 6;
		}
		if (n + elen > MACRO_GET_RESP_MAX - 14) {
			break; /* room for "\","fin":true} */
		}
		memcpy(&get_resp[n], esc, elen);
		n += elen;
		pos++;
	}

	n += snprintk(&get_resp[n], sizeof(get_resp) - n, "\"%s}",
		      pos >= s->len ? ",\"fin\":true" : "");
	get_resp_len = n;

	k_mutex_unlock(&store_lock);
	return 0;
}

const uint8_t *macro_get_response(uint16_t *len)
{
	*len = get_resp_len;
	return (const uint8_t *)get_resp;
}

/* --- MACRO_RW write entry point (called from ble.c, BT RX context) --------- */

/* Returns 0 on success, negative ATT error code on failure. */
int macro_write(const uint8_t *buf, uint16_t len)
{
	/* ~570 bytes: too much for the BT RX thread stack (2200 with
	 * BT_SETTINGS, shared with the whole ATT write path). Safe as static
	 * because GATT write callbacks all run on the single BT RX thread.
	 */
	static struct macro_req req;

	if (macro_req_parse(buf, len, &req) != 0) {
		LOG_WRN("Malformed macro write (%u bytes)", len);
		return -BT_ATT_ERR_VALUE_NOT_ALLOWED;
	}

	int err;

	if (strcmp(req.op, "put") == 0) {
		err = handle_put(&req);
	} else if (strcmp(req.op, "del") == 0) {
		err = handle_del(&req);
	} else if (strcmp(req.op, "get") == 0) {
		err = handle_get(&req);
	} else {
		return -BT_ATT_ERR_VALUE_NOT_ALLOWED;
	}

	if (err == -ENOSPC) {
		/* 0xE1 was already notified; tell the client the write failed. */
		return -BT_ATT_ERR_INSUFFICIENT_RESOURCES;
	}
	if (err) {
		return -BT_ATT_ERR_VALUE_NOT_ALLOWED;
	}
	return 0;
}

/* --- playback (standalone button trigger) ----------------------------------- */

static K_SEM_DEFINE(play_sem, 0, 1);
static uint8_t play_index;
static uint16_t play_len;
static bool play_busy;

/* Trigger playback of a macro. Async: returns immediately; if the slot is
 * empty this does nothing (and logs). A trigger while a previous macro is
 * still playing is dropped — re-copying play_buf mid-playback would mix
 * the two templates.
 */
void macro_play(uint8_t index)
{
	k_mutex_lock(&store_lock, K_FOREVER);
	bool ok = slots[index].used && !play_busy;
	uint16_t len = slots[index].len;

	if (ok) {
		play_busy = true;
		memcpy(play_buf, &arena[slots[index].off], len);
	}
	k_mutex_unlock(&store_lock);

	if (!ok) {
		LOG_INF("Macro %u not played (empty or busy)", index);
		return;
	}

	play_index = index;
	play_len = len;
	k_sem_give(&play_sem);
	LOG_INF("Macro %u playback queued (%u bytes)", index, len);
}

static void macro_play_thread(void *p1, void *p2, void *p3)
{
	ARG_UNUSED(p1); ARG_UNUSED(p2); ARG_UNUSED(p3);

	while (true) {
		k_sem_take(&play_sem, K_FOREVER);

		app_led_debug(APP_LED_MACRO_PLAY);
		LOG_INF("Playing macro %u (%u bytes)", play_index, play_len);

		/* Feeds the same ring buffer as NUS RX bytes; blocks until
		 * every byte is queued (the ring drains at typing speed). The
		 * snapshot in play_buf keeps this independent of the store.
		 */
		typing_play(play_buf, play_len);

		k_mutex_lock(&store_lock, K_FOREVER);
		play_busy = false;
		k_mutex_unlock(&store_lock);
	}
}

K_THREAD_DEFINE(macro_play_tid, 2048, macro_play_thread, NULL, NULL, NULL,
		K_PRIO_PREEMPT(9), 0, 0);

/* --- settings restore ---------------------------------------------------------
 *
 * Keys: "vkbm/<i>/n" (name) and "vkbm/<i>/t/<k>" (template chunk k, all but
 * the last chunk exactly MACRO_NVS_CHUNK bytes). Chunk load order is not
 * guaranteed, so the handler parks each chunk at the end of the arena and
 * records it in the boot table; macro_boot_finalize() (called after
 * settings_load()) validates and assembles the slots.
 */
struct boot_chunk {
	uint8_t slot;
	uint8_t k;
	uint16_t off;	/* chunk's parking offset in the arena */
	uint16_t len;
};

static struct boot_chunk boot_chunks[MACRO_SLOTS * MACRO_NVS_CHUNKS_MAX];
static uint16_t n_boot_chunks;

/* Assembly scratch for macro_boot_finalize(): the parked chunks live in the
 * arena, so the compacted result cannot be written back into it in place —
 * a slot's final bytes would overwrite parked chunks of slots not yet
 * processed whenever the NVS load order differs from slot order.
 */
static uint8_t boot_arena[MACRO_STORE_MAX];

static struct boot_chunk *boot_chunk_find(uint8_t slot, uint8_t k)
{
	for (uint16_t j = 0; j < n_boot_chunks; j++) {
		if (boot_chunks[j].slot == slot && boot_chunks[j].k == k) {
			return &boot_chunks[j];
		}
	}
	return NULL;
}

static int macro_settings_set(const char *key, size_t len,
			      settings_read_cb read_cb, void *cb_arg)
{
	const char *sep = strchr(key, '/');
	char *end;
	long idx = strtol(key, &end, 10);

	if (sep == NULL || end != sep || idx < 0 || idx >= MACRO_SLOTS) {
		return -ENOENT;
	}

	if (strcmp(sep + 1, "n") == 0) {
		if (len > MACRO_NAME_MAX) {
			return -EINVAL;
		}
		ssize_t n = read_cb(cb_arg, slots[idx].name, len);

		if (n < 0) {
			return n;
		}
		slots[idx].name_len = n;
		return 0;
	}

	if (sep[1] == 't' && sep[2] == '/') {
		long ck = strtol(sep + 3, &end, 10);

		if (*end != '\0' || ck < 0 || ck >= MACRO_NVS_CHUNKS_MAX ||
		    len > MACRO_NVS_CHUNK ||
		    n_boot_chunks >= ARRAY_SIZE(boot_chunks) ||
		    len > MACRO_STORE_MAX - arena_used) {
			LOG_WRN("Bad stored macro chunk (%s), skipped", key);
			return 0;
		}
		ssize_t n = read_cb(cb_arg, &arena[arena_used], len);

		if (n < 0) {
			return n;
		}
		boot_chunks[n_boot_chunks++] = (struct boot_chunk){
			.slot = (uint8_t)idx,
			.k = (uint8_t)ck,
			.off = arena_used,
			.len = (uint16_t)n,
		};
		arena_used += n;
		return 0;
	}

	return -ENOENT;
}

SETTINGS_STATIC_HANDLER_DEFINE(vkbm, "vkbm", NULL, macro_settings_set,
			       NULL, NULL);

/* Assemble the boot-table chunks into usable slots. A slot is usable when
 * its chunks are contiguous from k=0 and all but the last are full; anything
 * else (interrupted commit, corruption) is dropped. Must be called exactly
 * once, right after settings_load() — a second call would find an empty boot
 * table and clear the store.
 */
void macro_boot_finalize(void)
{
	uint16_t new_used = 0;

	for (uint8_t i = 0; i < MACRO_SLOTS; i++) {
		uint16_t total = 0;
		bool valid = true;

		for (uint8_t k = 0; ; k++) {
			struct boot_chunk *e = boot_chunk_find(i, k);

			if (e == NULL) {
				break;
			}
			if (e->len != MACRO_NVS_CHUNK &&
			    boot_chunk_find(i, k + 1) != NULL) {
				valid = false; /* short chunk must be last */
				break;
			}
			memcpy(&staging[total], &arena[e->off], e->len);
			total += e->len;
		}

		if (total == 0) {
			continue; /* no template stored for this slot */
		}
		if (!valid) {
			LOG_WRN("Macro %u chunks invalid, dropped", i);
			continue;
		}
		memcpy(&boot_arena[new_used], staging, total);
		slots[i].off = new_used;
		slots[i].len = total;
		slots[i].used = true;
		new_used += total;
		LOG_INF("Restored macro %u (%u bytes)", i, total);
	}

	memcpy(arena, boot_arena, new_used);
	arena_used = new_used;
	n_boot_chunks = 0; /* boot table no longer needed */
}
