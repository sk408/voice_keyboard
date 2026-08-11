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
- **Flash layout: OK.** `storage` partition at `0xDC000`/16 KB intact, app
  links at `0x26000`; bonds persist across reboot.

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

## Not verified here

No dongle is attached to this machine, so none of this is hardware-tested.
Build is clean and produces `build/zephyr/zephyr.uf2`.
