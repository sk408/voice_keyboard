# Voice Keyboard — InputStick firmware fix set: build result

All five fixes implemented, built with a **pristine** rebuild, and the build
**passed (exit 0)**.

## Build result

- Build command (from `firmware/README.md`), pristine: **exit code 0**.
- FLASH: **178648 B** (30.71%) of 568 KB
- RAM:   **48656 B**  (18.56%) of 256 KB
- UF2: `~/voice_keyboard/firmware/build/zephyr/zephyr.uf2` — **357376 bytes**
  (start address `0x26000`, family `0xada52840`).
- Baseline v6.0 was FLASH 177952 B / RAM 48528 B; the five fixes add ~696 B
  FLASH and ~128 B RAM.

## What changed, per fix

### Fix 1 [CRITICAL] — fragment BLE notifications to ≤20 bytes (`ble.c`)
`notify_work_fn()` now loops over the queued packet and emits it as
`MIN(len-off, 20)`-byte `bt_gatt_notify()` slices (`BLE_NOTIFY_CHUNK=20`),
instead of one whole-packet notify. The peer's `PacketReader` reassembles a
byte stream across notifications, so chunk boundaries are arbitrary. The
34-byte `GetFirmwareInfo` reply now ships as 20+14; the 18-byte status stays a
single notify.

### Fix 2 [CRITICAL] — 0x2F status layout + periodic drain counts (`inputstick.c`, `usb_kbd.c`, `vkb.h`)
- `send_hid_status()` now emits **11 data bytes**: `0xFF` moved from `st[11]`
  to `st[10]` (offset +10, the `data[11]==0xFF` gate USB Remote reads);
  `st[2]=st[4]=0x01` report protocol; buffer-empty flags stay `0x01`. 11 data
  bytes → payload 5+11=16 → 1 block → 18 B total (single notify).
- `SetUpdateInterval (0x31)` param is now stored (`status_interval_ms`) and
  drives a periodic `k_timer`. Interval is `param * 100` ms (param 4 = 400 ms);
  default 400 ms. A `k_timer` expiry defers the notify to the system workqueue
  (never `bt_gatt_notify` from ISR/BT-RX thread). Timer starts when Ready is
  first sent, restarts on a re-issued 0x31, and stops on disconnect.
- Real drain counts: `usb_kbd.c` keeps `atomic_t` per-interface counters
  (`kbd_sent`, `mouse_sent`, `consumer_sent`) incremented on each **successful**
  synchronous `hid_device_submit_report`. `usb_hid_drain_counts()` reads+resets
  them atomically; `send_hid_status()` copies them into `st[7..9]`.
- The one-shot Ready notification behavior is preserved (and still fires once);
  periodic status follows thereafter.

### Fix 3 [REQUIRED] — firmware version 101 (`inputstick.c`)
`respond_fw_info()` sets `info[2] = 1` (was 0) → version 101 (major=1, minor=1).

### Fix 4 [REQUIRED] — Identify (0x01) reply carries 0x42 (`inputstick.c`)
The Identify handler now replies (when the response flag is set) with one data
byte `0x42` ('B' = firmware running), satisfying the management screen.

### Fix 5 [WANTED] — 0x22 consumer/system media keys (`usb_kbd.c`, `inputstick.c`, `vkb.h`)
- Added a **Consumer Control** collection as report ID **4** to the existing
  single composite descriptor: usage page 0x0C, usage 0x01, usage min/max
  0x0000..0xFFFF, logical 0..0xFFFF, report size 16 / count 1, `Input(Data,
  Array, Abs)`. Report buffer = ID + 2 bytes = 3 bytes
  (`UDC_STATIC_BUF_DEFINE(consumer_report, 3)`).
- `usb_consumer_report(uint16_t usage)` submits `[4, LSB, MSB]` using the same
  `kb_ready` guard + `hid_device_submit_report` pattern as mouse/abs.
- `kb_get_report()` GET_REPORT case for report ID 4 added.
- `inputstick.c` adds `IS_CMD_HID_CONSUMER (0x22)` → `hid_consumer()`: for
  reportID 1 calls `usb_consumer_report(usage)`; reportID 2 (system) and any
  other ID are **skipped safely** (no System Control collection — no crash).

## Verification (beyond compile)

Extracted `hid_report_desc` (200 bytes) from `zephyr.elf` and parsed the HID
items: input report sizes are report ID 1 = 8 B, 2 = 4 B, 3 = 5 B, **4 = 2 B**
(data bytes, +1 ID byte each), matching `KB/MS/AB/CONSUMER_REPORT_COUNT`
(9/5/6/3). The existing three reports did **not** change size; the new consumer
report is byte-exact with its send path.

## Issues / risks

- **Fix 1 (fragmentation):** a dropped notify mid-packet (att_pool exhaustion,
  K_NO_WAIT) leaves the peer with a truncated packet; its CRC check fails and
  it re-syncs on the next 0x55 tag. This is the pre-existing "best-effort"
  behavior, now per-20-byte-chunk. No worse than the current single-notify
  path, and bounded.
- **Fix 2 (interval units):** implemented `param * 100` ms (param 4 = 400 ms).
  The task text said "units of 10 ms" but also "param 4 = 400 ms"; all three
  analysis reports + the spec agree on 400 ms for param 4, so 100 ms units is
  the authoritative reading. Flagging in case the "10 ms" phrasing was meant
  literally (it would yield 40 ms, contradicting the reports).
- **Fix 2 (drain mapping):** `st[9]` ("consumer reports sent") accumulates both
  the new consumer-control reports **and** the touchscreen/absolute-pointer
  reports, matching InputStick's "touchscreen rides the consumer queue" model.
  Keyboard → `st[7]`, mouse → `st[8]` are 1:1.
- **Fix 5 (system keys):** reportID 2 (power/sleep/wake) is intentionally not
  mapped (no System Control collection); it is dropped without error. Media
  keys (reportID 1) are the implemented priority. If system keys are needed
  later, add a System Control collection (usage page 0x01, usage 0x81–0x83) or
  a second report ID.
- DIS firmware revision string is still `vk-6.0` (not part of the requested
  changes; no bump performed). No flashing, no git commit, no bootloader
  change — build dir left in a working state.

## Nothing left incomplete

All five fixes are implemented and the build is clean. (Consumer system-page
keys were explicitly allowed to be skipped by the task, and were skipped
deliberately rather than left incomplete.)
