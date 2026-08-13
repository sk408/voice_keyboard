# Debug notes — "BLE connected, no keystrokes on the PC"

Static review of the NUS-bytes → HID-keystrokes chain, with the fixes applied
in this tree. Ordered by likelihood of causing the reported symptom.

## Bugs found (ranked)

### 1. TX status notify sent on the wrong GATT attribute — ACTIVE BUG (fixed)

`ble.c` `ble_notify_status()` used `&nus_svc.attrs[1]`. Attribute layout of
`nus_svc`:

- `attrs[0]` primary service
- `attrs[1]` TX characteristic **declaration**
- `attrs[2]` TX characteristic **value**
- `attrs[3]` TX CCC
- `attrs[4]` RX declaration
- `attrs[5]` RX value
- (v3) `attrs[6]` config characteristic **declaration**
- (v3) `attrs[7]` config characteristic **value** — the TX **value** is still
  `attrs[2]`; the config characteristic is appended after RX, so the fix
  below is unaffected
- (v5) `attrs[8]` MACRO_LIST declaration, `attrs[9]` MACRO_LIST **value**
  (notify target), `attrs[10]` MACRO_LIST CCC, `attrs[11]` MACRO_RW
  declaration, `attrs[12]` MACRO_RW value

`BT_GATT_CHARACTERISTIC` expands to *two* attributes (declaration + value), so
`attrs[1]` is the declaration, not the value. Notifications went out with the
declaration's handle, which no central ever subscribes to — every busy/idle
status byte was silently dropped by the phone. This kills the "typing…" badge
and, worse, any app-side write pacing that waits for a status byte: the
firmware also never sent an *initial* idle status (statuses were only emitted
after writes), so a central waiting for `0x00` before its first RX write
starves forever → **zero bytes ever reach the dongle → zero keystrokes**.

Fix (`ble.c`): notify on `attrs[2]`, and send an initial `0x00` (idle) from
`nus_tx_ccc_changed()` when notifications are enabled.

### 2. HID report buffer violated the UDC alignment contract — LATENT (fixed)

`usb_kbd.c` `usb_kbd_report()` built the report in a stack local
(`uint8_t report[8]`) and passed it to `hid_device_submit_report()`. The HID
class requires UDC-aligned buffers (`IS_UDC_ALIGNED` assert in
`usbd_hid.c: hid_buf_alloc_ext()`); `CONFIG_ASSERT` is **off** in this build,
so a misaligned buffer fails *silently* — on nRF52840 the EasyDMA transfer is
then corrupted/lost. Worse: with no `input_report_done` callback registered,
`hid_dev_submit_report()` blocks in `k_sem_take(&in_sem, K_FOREVER)` until the
transfer completes, so one lost completion hangs the typing thread
permanently — no keystrokes, no recovery, no log.

I disassembled the shipped image: the array happened to land 8-byte aligned
(`strd [sp]` at `usb_kbd_report+0x4`), so this was **not** the active killer
in that exact binary — but any unrelated code change could shift the frame and
break it. Fixed the way Zephyr's `samples/subsys/usb/hid-keyboard` does it:
`UDC_STATIC_BUF_DEFINE(kb_report, KB_REPORT_COUNT)`. Safe because submission
is synchronous and the typing thread is the only producer.

### 3. `GET_REPORT` stalled the control pipe — LATENT, host-dependent (fixed)

`usb_kbd.c` `kb_get_report()` returned `-ENOTSUP`. `usbd_hid.c
handle_get_report()` maps any non-positive return to a protocol stall. If the
host HID stack issues `GET_REPORT(INPUT)` during device start (some
Windows/host stacks do), the device can be failed at enumeration or marked
malfunctioning → no keystrokes even though everything else is right. Fix:
answer with the last submitted report (the static buffer doubles as state) and
return a positive byte count.

### 4. `kb_ready` cross-thread flag without synchronization — hardening (fixed)

Plain `bool` written by the USBD thread (`kb_iface_ready`), read by the typing
thread. Now `atomic_t`.

## Prime suspects checked and CLEARED (with evidence)

- **Report descriptor vs report bytes (suspect #1): OK.**
  `HID_KEYBOARD_REPORT_DESC()` (Zephyr 4.1 `include/zephyr/usb/class/hid.h:469`)
  is a plain 8-byte boot keyboard report — 8 modifier bits, 1 reserved byte,
  6 keycode bytes, **no Report ID**. `usb_kbd_report()` sends exactly 8 bytes
  with mods at [0] and the key at [2]. Byte-exact agreement.
- **Interface state gating (suspect #2): OK.** `kb_ready` is set from the
  `iface_ready` callback (fired by `usbd_hid_enable/disable` on
  SET_CONFIGURATION) and checked before every submit.
- **usbd stack selection (suspect #3): OK.** `build/zephyr/.config`:
  `CONFIG_USB_DEVICE_STACK` unset, `CONFIG_USB_DEVICE_STACK_NEXT=y`,
  `CONFIG_USBD_HID_SUPPORT=y`, `CONFIG_SERIAL`/`CONFIG_CONSOLE` unset, no
  CDC-ACM class compiled. The legacy stack is fully evicted; the earlier
  double-USBD-IRQ symptom cannot recur.
- **Typing thread (suspect #4): OK.** `K_THREAD_DEFINE` autostarts it; ring
  buffer is single-producer (BT RX thread) / single-consumer; semaphore
  accounting can't deadlock (worst case a spurious wake with 0 bytes);
  `typing_reset()` on disconnect is safe.
- **NUS write wiring (suspect #5): OK for RX.** The RX write handler is
  registered on the correct (value) attribute via `BT_GATT_CHARACTERISTIC`;
  encrypted-write permission as required. (The TX side had bug #1.)
- **SET_IDLE / boot protocol (suspect #6): OK.** `set_protocol` is provided
  (mandatory — the DT `protocol-code = "keyboard"` sets boot subclass, and
  registration fails without it); idle rate is stored and ignored, which is
  correct for event-driven reports under `SET_IDLE(0)`.
- **VBUS/enable flow: OK.** `udc_nrf` reports `can_detect_vbus = true`, and
  `msg_cb` calls `usbd_enable()` on `USBD_MSG_VBUS_READY` — same pattern as
  the working hid-keyboard sample. Since BLE runs, `main()` provably got past
  `usbd_init()` without error.
- **Flash layout: OK.** `storage` partition intact (moved to `0xB4000`/32 KB
  in v5, see below); app links at `0x26000`; bonds persist across reboot.

## Likely full story

Firmware-side, the only *active* defect found is #1 (plus the app-side
write-queue gating tracked in `mission_debug_web.txt`): no status byte ever
reached the phone, so nothing proved writes were even attempted, and an app
that gates its first write on an initial idle status would never write at
all. The LED codes below make the next flash tell us exactly where the chain
breaks if it still does.

## Red LED debug codes (temporary bring-up aid, safe to ship)

The dongle's red LED (led1, part of RGB LED2) now signals the chain state.
Green LED behavior is unchanged (blink = advertising, solid = connected).

| Signal | Meaning |
|---|---|
| solid 1 s | USB HID interface **ready** — the host set the configuration (enumeration completed) |
| 1 × 80 ms blink | NUS **RX write received** — bytes entered the typing queue |
| 2 × 80 ms blinks | **first HID report clocked out by the host** this session (submit is synchronous in this stack: success means the host actually polled the report off the interrupt IN endpoint) |
| 3 × 120 ms blinks | **HID submit failed** — keystroke attempted while the interface was not ready, or `hid_device_submit_report()` returned an error |
| 4 × 60 ms blinks | **mouse packet received** (v2 `0x90`) — full packet parsed and forwarded as a report-ID-2 mouse report |
| 5 × 60 ms blinks | **absolute pointer packet received** (v4 `0x91`) — full packet parsed and forwarded as a report-ID-3 absolute pointer report |
| 6 × 60 ms blinks | **macro playback started** (v5) — a stored macro (standalone button trigger) began feeding the typing engine |

Reading the chain after sending text from the app:

- **No red at all** → writes never reach the dongle: problem is app-side
  (write queue, write type vs characteristic properties) or the link isn't
  encrypted/bonded.
- **1-blink per write, no 2-blink, and 3-blinks** → bytes arrive but USB is
  failing: check Device Manager for the "HID Keyboard Device" and whether the
  solid-1s ready pulse ever appeared after plug-in.
- **1-blink + 2-blink, still nothing typed** → the full firmware chain works;
  look at the host (keyboard focus, layout, HID filter drivers).

Codes are emitted from `nus_rx_write()` (BT RX context), `kb_iface_ready()`
and `usb_kbd_report()` (USBD/typing context) via `app_led_debug()` in
`main.c`, which just reschedules a workqueue item — no blocking in callers.

## v3: config characteristic (device name)

v3 appends a config characteristic (`5A1B0001-8C4D-4E2F-9A3B-7C6D5E4F3A2B`,
read + write-with-response, encrypted link) to the same GATT service. It
accepts a 1–20 char printable-ASCII device name, persists it as `vkb/name`
via the settings subsystem (`SETTINGS_STATIC_HANDLER_DEFINE`, restored at
boot by the existing `settings_load()`), applies it to the GAP Device Name
via `bt_set_name()` (`CONFIG_BT_DEVICE_NAME_DYNAMIC=y`), and rebuilds the
advertising complete-name field from it on every advertise start — so a name
set while connected shows up after the next disconnect, and worst case after
a reboot. DIS firmware revision is `vk-4.0` since v4 (was `vk-3.0`). The
notify-on-`attrs[2]` fix is unaffected: the config characteristic is
appended after RX, so the TX value attribute index does not move.

## v4: absolute pointer (report ID 3)

v4 appends a third application collection to the composite report
descriptor (keyboard ID 1 and mouse ID 2 byte-exactly as before, verified
against the v3 build's compiled descriptor bytes): a digitizer-class Touch
Screen collection (usage page 0x0D, usage 0x04, Finger logical collection)
with 3 buttons (usage min/max 1..3, 1 bit each + 5 padding bits) and
absolute X/Y (Generic Desktop 0x30/0x31, logical 0..32767, 16 bits each) —
input report ID 3 = 6 bytes including the ID byte. The `0x00 0x91
<buttons> <x_lo> <x_hi> <y_lo> <y_hi>` escape is parsed with the same
chunked-escape state machine as `0x90` and forwarded without the keystroke
rate limit. Descriptor vs send path was verified byte-exactly on the
compiled image: `hid_report_desc` (173 bytes, symbol extracted from
`zephyr.elf`) parses to input report lengths 9/5/6 bytes for IDs 1/2/3,
matching `KB_REPORT_COUNT`/`MS_REPORT_COUNT`/`AB_REPORT_COUNT`.

## v5: dongle-stored macros + standalone trigger

v5 appends MACRO_LIST (`5A1B0002-…`, read + notify) and MACRO_RW
(`5A1B0003-…`, write-with-response + read) to the same service, both
encrypted-link only (see PROTOCOL.md for the wire format). The store
(`macro.c`) keeps 16 slots under a 16 KB budget, mirrored in RAM and
persisted via settings/NVS as `vkbm/<i>/n` + `vkbm/<i>/t/<k>` — templates
are chunked at 2 KB because one NVS record must fit a 4 KB flash sector.
Chunk keys are reassembled and validated at boot (`macro_boot_finalize()`,
called right after `settings_load()` in `ble_init`); a partial set drops
the slot rather than playing back a corrupt template.

Two layout changes came with it:

- **Storage partition moved**: the stock 16 KB at `0xDC000` (4 NVS sectors)
  cannot hold a 16 KB macro store alongside bonds/name (NVS needs a free
  sector for GC). The overlay moves `storage` to `0xB4000`/32 KB (8
  sectors), carved out of the unused slot1 partition, and
  `CONFIG_FLASH_LOAD_SIZE` shrank to `0x8E000` so the app can never grow
  into it (current image ends near `0x5D000`). Bonds/name from ≤v4 are not
  migrated — re-pair once after flashing.
- **Button interrupts now fire on both edges** (`GPIO_INT_EDGE_BOTH`): the
  debounced handler times press→release; ≥1.5 s with no BLE connection
  plays macro slot 0 through the normal typing ring (`typing_play()`, same
  path as NUS RX bytes), a short press opens the pairing window as before.

The minimal JSON walker in `macro.c` parses the fixed client shape only and
unescapes `data` at the byte level (printable ASCII, `\"`/`\\`, `\u00XX`
per raw byte), so chunk boundaries may split UTF-8 characters and escape
sequences freely. DIS firmware revision is `vk-5.0`.

## v5.1: boot-failure hunt (red LED at plug-in, then nothing)

Symptom on hardware: v5 UF2 flashes fine, but after the bootloader hands off
there is no green advertising blink and no BLE — death somewhere between
bootloader handoff and `bt_le_adv_start()`.

Static audit of the v5 delta (`9b7ad61..40b9254`) came up clean: overlay
partition math verified against `fstab-stock.dtsi` (storage `0xB4000`/32 KB
fits the carved-down slot1, no overlap; generated `zephyr.dts` confirmed),
`.config` diff vs a fresh v4 build is exactly five lines (MTU sizes, DIS rev
string, `FLASH_LOAD_SIZE`), no merge artifacts in `main.c`/`ble.c`/`macro.c`,
memory report well within limits (FLASH 224 KB/568 KB, RAM 116 KB/256 KB),
UF2 regenerated at `0x26000`/family `0xada52840`. NVS mount is bounded even
on garbage flash (fixed-step ATE walk within sector bounds), and the macro
store's boot path is a no-op on an empty store. The root cause is therefore
**not statically provable** — it needs one observed boot.

Two changes ship for that:

- **Boot-stage trace on the red LED** (`app_boot_stage()`, called from
  `main.c`/`ble.c`): N slow blinks (80 ms on/off, 300 ms gap) = stage N
  completed. The last code seen pinpoints the death stage.

  | Blinks | Stage completed | Hang after it means death in… |
  |---|---|---|
  | *(none)* | — | kernel/driver init, before `main()` |
  | 1 | `main()` entered, LEDs/timer configured | button or USB init |
  | 2 | USB HID stack up | `bt_enable()` (BLE controller/host) |
  | 3 | BLE stack up | `settings_load()` / macro-store restore (NVS on the moved partition) |
  | 4 | settings + macro store loaded | advertising start |
  | 5 | advertising up | — (normal green blink takes over; boot OK) |

  A healthy boot shows 1→5 in ~4 s, then the usual green advertising blink.
- **Controller PDU length pinned to the v4 value**
  (`CONFIG_BT_CTLR_DATA_LENGTH_MAX=27`): in v5 it silently followed
  `BT_BUF_ACL_RX_SIZE` to 200 (Kconfig default), changing the link layer vs
  the hardware-verified v4 build. The 180-byte macro chunks only need
  host-side L2CAP (re)assembly, so DLE 27 costs nothing but upload speed
  (more, smaller PDUs) and removes the whole controller-behavior delta.

**Final flash budget**: app capped at `0x8E000` (568 KB, currently 224 KB =
39 %); storage `0xB4000`–`0xBC000` = 32 KB NVS (8 sectors); macro store
budget 16 KB across 16 slots, leaving 16 KB of NVS headroom for bonds, the
device name, and GC. RAM 116 KB/256 KB (44 %).

## v5.2: root cause found — NVS mount inside `bt_enable()` aborts it

Hardware observation on v5.1: the boot-stage trace stops at **2 blinks** —
death inside `bt_enable()`. The v5.1 write-up above concluded "bounded even
on garbage flash" for NVS and looked only for a *hang*. The miss: NVS being
bounded doesn't help when the mount **fails** — because of where the mount
happens in Zephyr 4.1:

`bt_enable()` → `bt_init()` → `bt_settings_init()` →
`settings_subsys_init()` → NVS **mount on the storage partition, inside
`bt_enable()`** (hci_core.c, settings.c). With
`CONFIG_NVS_INIT_BAD_MEMORY_REGION=n`, flash that isn't a recognizable NVS
(e.g. every sector's closing-ATE slot non-erased → "all sectors closed")
fails the mount with `-EDEADLK`, `bt_init()` propagates the error,
`bt_enable()` returns it, `ble_init()` returns it, `main()` returns — red
LED frozen at 2 blinks, no advertising, no BLE. Exactly the observed
symptom, no hang required.

Why v5 introduced it and v4 didn't hit it: v4's storage partition was the
stock `0xDC000` region, initialized as NVS by v2/v3 long ago — clean mount
every boot. v5 moved storage to `0xB4000`, a region that was previously
*legal app space* (v4 allowed images up to `0x26000+0xCE000 = 0xF4000`) and
may carry old app tails or DFU residue — garbage from NVS's point of view.
The v5.1 DLE pin (`BT_CTLR_DATA_LENGTH_MAX=27`) was a red herring: it
addressed an on-air link-layer theory, but the boot never gets on-air.

Fix (this commit): `ble_init()` mounts the settings backend **itself**
before `bt_enable()` (`settings_subsys_init()`); on failure it erases the
whole storage partition (`flash_area_flatten()`) and retries, so the mount
always sees a valid, empty NVS and `bt_enable()`'s internal mount becomes a
no-op. A repair erase loses bonds/name — re-pair once. The custom device
name feature (v3) was re-audited against this failure mode: its settings
handler and `bt_set_name()` run only *after* stage 3, so it is not on the
`bt_enable()` path and is left intact.

### New red-LED codes (v5.2)

Short blinks stay the stage codes above. Long blinks (400 ms) are
sub-stages inside the `bt_enable()` path; repeating patterns are
unrecoverable errors:

| Pattern | Meaning |
|---|---|
| 1 long blink | settings pre-mount running (normal on every boot) |
| 2 long blinks | NVS mount failed → storage partition erased, retrying (expected once on dirty flash; re-pair afterwards) |
| repeating fast blink (100 ms) | `bt_enable()` returned an error *with settings storage OK* — failure is elsewhere in BLE bring-up |
| repeating 3-long-blink group | settings storage unrecoverable even after a full erase (flash hardware problem) |
| repeating slow blink (1 s) | **hard fault** (`k_sys_fatal_error_handler` override; previously a fault died silently at the last stage code — `CONFIG_RESET_ON_FAULT=n`) |

Healthy v5.2 boot: 1, 2 short → 1 long → 3, 4, 5 short, then the green
advertising blink.

## v5.3: connect fails ("unsupported GATT" in the web app) — bondless dongle rejects every peer

Hardware observation on v5.2: clean boot, green advertising blink, but the
web app's connect fails with a GATT error and the dongle appears dead.

Static audit (no fault found): the web↔firmware UUIDs match (NUS, config
`5a1b0001`, MACRO_LIST `5a1b0002`, MACRO_RW `5a1b0003`); the v5 GATT attr
layout is consistent (`ble_notify_status` → attrs[2], `ble_notify_macro_list`
→ attrs[9], both VALUE attributes); the config/name read is a bounded
`bt_gatt_attr_read()` over a 21-byte static buffer; `bt_set_name()` is
length-checked against `CONFIG_BT_DEVICE_NAME_MAX=28`; the MACRO_LIST CCC's
NULL changed-callback is NULL-checked in this Zephyr (gatt.c:2194);
`bt_hci_cmd_send_sync()` from the disconnected callback cannot deadlock
because CMD_COMPLETE/CMD_STATUS are *prio* events handled in driver RX
context, not on the BT workqueue. **The custom device-name feature is
exonerated as the crash mechanism**: nothing in its read/write/boot path
faults, and its only connect-time effect is being the first *encrypted* GATT
op — a role the v5 macro characteristics would take over anyway.

The provable failure is the bonded-peer gate: v5 moved the settings
partition (`0xDC000` → `0xB4000`) and v5.2's repair path erases it, so the
dongle holds **zero bonds**. `connected()` disconnects any unbonded peer
while the pairing window is closed (button not pressed), so every web-app
connect dies during service discovery — Chrome surfaces that as a
NotSupported/NetworkError ("unsupported GATT") and, with the auto-resumed
advertising easy to miss, the dongle looks crashed. A phone holding a
*v2-era stale bond* adds a second failure layer at the first encrypted read
(the config/name char): encryption with the stale LTK fails and the re-pair
depends on the phone OS handling it gracefully inside the window.

Fix (this commit):

1. **Bondless recovery**: `ble_init()` counts stored bonds after
   `settings_load()`; with zero bonds it opens the 60 s pairing window once
   at boot, so a factory/repaired dongle is pairable without physical
   button access. The window still auto-closes and the bonded-peer gate is
   unchanged once a bond exists. After re-pairing, the phone's stale bond
   should be forgotten once (web app "forget" or OS Bluetooth settings).
2. **Connect-stage trace** (new red-LED codes below) so the next flash
   pinpoints the death stage if a real fault remains.

### New red-LED codes (v5.3)

200 ms pulses, distinct from the 60–120 ms RX/HID codes:

| Pattern | Meaning |
|---|---|
| 7 blinks | connect reached `connected()` but the peer was **rejected** — no bond and pairing window closed (the bondless case above) |
| 8 blinks | security/pairing failed (`security_changed` error — e.g. stale phone bond) |
| 9 blinks | central subscribed to NUS TX (service discovery + subscribe succeeded) |
| 10 blinks | **first encrypted read completed** — since v5.5 emitted from the MACRO_LIST read handler (the config characteristic it used to mark is gone) |
| repeating slow blink (1 s) | hard fault (unchanged, v5.2) |

Healthy connect (v5.5): green solid, then 9 blinks (TX subscribed), then
10 blinks when the web app reads MACRO_LIST during the connect-time macro
sync, then usable.

## v5.4: hang right after TX subscribe — notify from the BT RX thread

Hardware observation on v5.3: the bondless-recovery fix worked — the phone
connects, pairs and subscribes (9 blinks = `APP_LED_TX_SUB`, green solid) —
but then the dongle hangs: the 10th blink (config read) never fires, no
further GATT is answered, and there is no 1 s slow red blink, so it is a
hang, not a fault.

Root cause, statically proven against the Zephyr 4.1.0 tree:

- `nus_tx_ccc_changed()` (TX CCC write callback) runs on the **BT RX
  thread** and called `ble_notify_status(0x00)` synchronously (ble.c:86).
- `bt_gatt_notify()` → `gatt_notify()` (gatt.c:2494) → `bt_att_create_pdu()`
  → `bt_att_chan_create_pdu()` (att.c:713): for a notification the
  allocation timeout is **K_FOREVER** unless the caller is the system
  workqueue or the ATT-response thread (att.c:733-742), then
  `bt_l2cap_create_pdu_timeout(&att_pool, 0, K_FOREVER)` (att.c:747).
- `att_pool` has **3 buffers** (`CONFIG_BT_ATT_TX_COUNT=3`), shared with the
  ATT responses of Android's MTU exchange + service discovery, which drain
  slowly at `BT_CTLR_DATA_LENGTH_MAX=27`. The buffers are freed by HCI/ATT
  TX-completion processing — which runs on the **same BT RX thread**. att.c
  documents exactly this deadlock class (att.c:170-180: queuing an ATT
  request from a callback blocks until a resource is available, and the
  callbacks run on the same thread that frees the resources).
- So when the pool is exhausted at subscribe time, the RX thread blocks
  forever inside `bt_gatt_notify()`: the ATT server dies with the phone
  still connected — 9 blinks, solid green, no 10th blink, no fault.

The same hazard existed at every other notify call site reached from the RX
thread: `ble_notify_status(VKB_TX_ERR_STORE_FULL)` and
`ble_notify_macro_list()` from `macro_write()` (MACRO_RW write handler).

Fix (this commit): **all notifications are deferred to the system
workqueue** (`K_WORK`), where `bt_att_chan_create_pdu()` uses K_NO_WAIT by
construction — the worst case is a dropped best-effort status byte, never a
blocked thread. `ble_notify_status()` coalesces to the latest pending byte
(last-write-wins; the initial idle `0x00` is re-queued on every subscribe);
`ble_notify_macro_list()` lost its json/len parameters and rebuilds the
list JSON at send time, so the notification always carries the latest store
state. The web app does not gate its first write on the initial status
(ble.ts send queue is independent of the status listener), so a dropped
status under transient pool pressure is harmless.

No LED code changes (the v5.3 connect-stage trace is unchanged). DIS
firmware revision is `vk-5.4`.

## v5.5: hang persists — the v3 config characteristic is removed outright

Hardware observation on v5.3 **and** v5.4 (identical on both): TX subscribed
(9 blinks), green LED solid, then **no 10th blink** — the config/name read
never completes, no further GATT response, web app dead. The v5.4
workqueue-notify fix did not change this, so the CCC-callback notify theory
is falsified as the cause of *this* hang (the fix stays — it removed a real,
statically proven K_FOREVER att_pool deadlock class; do not regress it).

The 10th blink was emitted inside `config_read`, so the config
characteristic path is the exact stalling operation, and the configurable
device-name feature (v3) is the only feature separating v2 (last known-good
on hardware) from the hanging builds. With the feature now implicated by
direct evidence, it is **removed outright** (stability over the feature):

- Config characteristic (`5A1B0001-…`) deleted from the GATT table, along
  with `config_read`/`config_write`, `device_name_valid`,
  `apply_device_name`, the `device_name`/`device_name_len` globals, the
  `vkb_settings_set` handler + `SETTINGS_STATIC_HANDLER_DEFINE(vkb, …)` and
  the `settings_save_one("vkb/name", …)` call.
- Dynamic GAP-name machinery gone: no `bt_set_name()`, no
  `CONFIG_BT_DEVICE_NAME_DYNAMIC` (removed from prj.conf), advertising data
  carries the fixed compiled-in name `VoiceKB` statically. Boot no longer
  touches settings for the name.
- Everything else is unchanged: v5.4 workqueue notifications (K_WORK,
  K_NO_WAIT allocation semantics), bondless recovery + 60 s self-opened
  pairing window, the v5 macro store (MACRO_LIST/MACRO_RW, flash store,
  standalone button trigger, MACRO_LIST notify), and the v2 core (composite
  HID kbd+mouse, sticky modifiers, trackpad).
- GATT attribute layout shifted down by two: MACRO_LIST value is now
  `attrs[7]` (was `attrs[9]`); `ble_notify_macro_list()` updated. The TX
  status notify target (`attrs[2]`) is unaffected.
- The 10th connect-stage blink is **repurposed**: `APP_LED_NAME_READ` moved
  to the MACRO_LIST read handler, so 10 blinks now means "first encrypted
  GATT read completed" and the next hardware test still pinpoints a stall.

### LED map (connect-stage trace, v5.5)

| Pattern | Meaning |
|---|---|
| 9 blinks (200 ms) | central subscribed to NUS TX |
| 10 blinks (200 ms) | first encrypted read done (MACRO_LIST read handler) |

Web side needs no change: the app's `getCharacteristic(CONFIG_CHAR_UUID)`
failure is caught (`config = null`, `supportsDeviceName` false, rename UI
hidden, `refreshDeviceName` no-ops) — verified in `web/src/ble.ts` and
`web/src/store.ts`. DIS firmware revision is `vk-5.5`.

## v5.6: v5 macro store stripped — bisect back to the known-good v2 core

Hardware observation on v5.5: connect reaches 9 blinks (TX subscribed),
then 10 blinks (MACRO_LIST read entered, first encrypted GATT read), then
the dongle goes unresponsive — link up, ATT dead. Same hang class as every
v5.x iteration. The macro store characteristics are the only remaining
delta from the v2 core that never worked on hardware, so they are **removed
outright** as a deliberate bisect: prove the clean core, re-add macros
incrementally later.

Removed:

- MACRO_LIST characteristic (declaration, value, CCC) and `macro_list_read`.
- MACRO_RW characteristic and `macro_rw_read` / `macro_rw_write`.
- `ble_notify_macro_list()` + `macro_list_notify_work` in ble.c.
- `macro.c` excluded from the build (CMakeLists); the file stays in the
  tree as the reference for the re-add. Its entry points are gone with it:
  no `macro_boot_finalize()` after `settings_load()`, no `macro_abort_put()`
  on disconnect, no button → `macro_play()` (a long press now just logs).
- vkb.h macro declarations and `VKB_TX_ERR_STORE_FULL` (0xE1) removed.

Kept (do not regress): v2 composite HID core (kbd+mouse+abs pointer,
sticky modifiers, trackpad, all typing/pointer layers), v5.4 deferred
workqueue notifications (never `bt_gatt_notify()` on the BT RX thread),
v5.3 bondless recovery (60 s self-opened pairing window with zero stored
bonds), v5.2 NVS mount/repair before `bt_enable()`, connect-stage LED
trace, hard-fault blink. The nus_svc table is back to 6 attributes
(`attrs[0..5]`); the TX status notify target (`attrs[2]`) is unchanged.
The v5 ATT MTU headroom (`ACL_RX/L2CAP_TX_MTU=200`,
`BT_CTLR_DATA_LENGTH_MAX=27` pin) is kept so the on-air link stays
byte-identical to the v5.x builds.

The 10th connect-stage blink has no trigger anymore (it fired from the
MACRO_LIST read handler, and no app-level encrypted read remains); the
enum/`main.c` case are retained. The trace now ends at 9 blinks = TX
subscribed.

**For the future re-add** (strong hypothesis for the v5.5 hang): the stall
was in `macro_list_read` → `macro_list_json()` →
`k_mutex_lock(&store_lock, K_FOREVER)` on the BT RX thread — `store_lock`
was most likely leaked (locked but never released) by
`macro_boot_finalize()` or another path, so the first GATT read that took
the lock blocked the RX thread forever. Audit every `store_lock` critical
section for early-return leaks before re-exposing any macro GATT read.

To re-add macros: restore the `src/macro.c` line in CMakeLists.txt, the
macro block + `ble_notify_macro_list()` in vkb.h, and the GATT surface in
ble.c — all recoverable from git history (v5.5, da3541e).

Web side needs no change (verified): `web/src/ble.ts` catches the absent
MACRO_LIST/MACRO_RW `getCharacteristic()` calls (`macroList`/`macroRw` =
null → `supportsMacroStore` false) and `web/src/store.ts` falls back to
localStorage macros. DIS firmware revision is `vk-5.6`.

## v5.7: web-app-only pairing connects but never types — force encryption

Hardware observation on v5.6: the web app connects cleanly, TX subscribe
fires (9 blinks), no errors — but the dongle never acts as a keyboard.
The only ever-working version (v2, 986f3f1) required OS-menu pairing first,
then the web-app connect; web-app-only pairing "had this same behavior" in
v2. On current firmware the OS-holds-the-connection one-central limit makes
the v2 two-step flow unreproducible, so the keystroke path must be made to
work from a web-app-only connection.

Root cause: the RX characteristic is `BT_GATT_PERM_WRITE_ENCRYPT`, so a
keystroke write needs an *encrypted* link, but nothing in `firmware/src/`
ever called `bt_conn_set_security()` — the dongle never proactively
escalates the link. The web app (`web/src/ble.ts` `send()`) prefers
`writeValueWithoutResponse` when the characteristic advertises it (RX has
`BT_GATT_CHRC_WRITE_WITHOUT_RESP`), and a Write Command to an
ENCRYPT-only characteristic on an unencrypted link is dropped by the ATT
server with no error reply (a command has no response PDU) — exactly
"connects fine, no errors, but no typing". TX + its CCC are permission-free
(`BT_GATT_PERM_NONE` / `READ|WRITE`), which is why connect + subscribe
succeed with no pairing. Web Bluetooth does not expose the ATT
"Encryption Required" attribute permission to JS, so Chrome has no reason
to encrypt before the first write; v2 only worked because the OS-level
pair had already produced a bond + encryption the web app reused.

Fix (`ble.c` `connected()`, after the bonded-peer gate):
`bt_conn_set_security(conn, BT_SECURITY_L2)` on every accepted connection.
With no stored bond this sends a SMP Security Request and triggers **Just
Works** pairing from the central; with an existing bond it re-encrypts from
the stored LTK. Verified against the Zephyr 4.1.0 tree:

- `bt_conn_set_security()` → `start_security()` → (peripheral role)
  `bt_smp_start_security()` → `smp_send_security_req()`; the peripheral
  emits a Security Request PDU and the central (Chrome) pairs/encrypts.
- `BT_SECURITY_L2` is sufficient for `BT_GATT_PERM_WRITE_ENCRYPT`:
  `sec_level_reachable()` (`smp.c:2756`) returns `true` unconditionally for
  L1/L2, and `remote_sec_level_reachable()` returns 0 for L2.
- Just Works completes with the existing cancel-only `auth_cb`:
  `get_io_capa()` (`smp.c:335`) returns `BT_SMP_IO_NO_INPUT_OUTPUT` when no
  passkey/pairing callbacks are set (only `cancel`), and with
  `CONFIG_BT_SMP_SC_PAIR_ONLY=y` the `pairing_confirm` callback is never
  consulted (the SC Just Works path skips it, `smp.c:3062`) — no user
  interaction, no new callback needed.

Reconciled with the v5.3 gate (unchanged): the `bt_conn_set_security()`
call is placed *after* the `!pairing_window_open && !peer_is_bonded()`
rejection, so a peer connecting inside the 60 s window (or the bondless
recovery boot window) is accepted and then paired + bonded + encrypted; a
bonded peer outside the window re-encrypts from its LTK; an unbonded peer
outside the window is still rejected before any security escalation. The
60 s pairing window, bondless recovery, `bt_set_bondable()` toggling, and
the workqueue-notify rule are all untouched.

DIS firmware revision is `vk-5.7`.

## Not verified here

No dongle is attached to this machine, so none of this is hardware-tested.
Build is clean and produces `build/zephyr/zephyr.uf2`.
