# Voice Keyboard BLE Protocol v4

Contract between the nRF52840 dongle (BLE peripheral, USB HID keyboard toward PC)
and any central client (web app now; native Android/iOS apps later).

## Identity

- Advertising name: `VoiceKB` by default; user-settable via the config characteristic (v3).
- Transport: BLE only. USB side is a standard HID keyboard (boot protocol), no vendor interface.
- Security: **LE bonding required** (Just Works). All writes require an encrypted link.
  Pairing window: bondable for 60s after a single press of the dongle button;
  outside the window, only already-bonded centrals may connect. (v1 fallback if the
  button conflicts with the UF2 bootloader: always bondable, accept first-pair risk.)

## GATT — Nordic UART Service (NUS)

Standard NUS UUIDs so generic BLE UART libraries/apps work out of the box:

| Role | UUID | Properties | Notes |
|---|---|---|---|
| Service | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` | — | NUS |
| RX (central→dongle) | `6E400002-B5A3-F393-E0A9-E50E24DCCA9E` | write, write-no-resp | keystroke payload |
| TX (dongle→central) | `6E400003-B5A3-F393-E0A9-E50E24DCCA9E` | notify | status bytes |

Also standard DIS (0x180A) with Firmware Revision String = `vk-4.0`.

## GATT — config characteristic (v3)

One vendor characteristic on the same (NUS-UUID) service:

| Role | UUID | Properties | Notes |
|---|---|---|---|
| Config | `5A1B0001-8C4D-4E2F-9A3B-7C6D5E4F3A2B` | read, write-with-response | device name |

- Write payload: UTF-8 device name, **1–20 chars, printable ASCII (0x20–0x7E)
  only**; anything else is rejected (`Value Not Allowed`). No NUL terminator.
- The name is persisted in flash (settings subsystem) and applied as both the
  GAP Device Name and the complete name in the advertising data. If written
  while connected (the normal case), the new name appears on the next
  advertising start (i.e. after disconnect); the GAP Device Name
  characteristic updates immediately. Default name: `VoiceKB`.
- Read returns the current name (no NUL terminator).
- Like RX, both read and write require the encrypted/bonded link.
- Macros (see the web app) are purely an app-side composition feature: they
  compile to the ordinary RX byte stream above and need no firmware support
  beyond this characteristic.

## RX payload (typing)

Stream of bytes, any chunking; dongle types as received, rate-limited (~15 ms/keystroke).

- Printable UTF-8 → typed on US keyboard layout (shift handling in firmware)
- `\n` → Enter, `\t` → Tab, `0x08` → Backspace
- `0x00` = escape: next byte is a special key:
  - `0x01` Esc, `0x02` Up, `0x03` Down, `0x04` Left, `0x05` Right,
    `0x06` Delete, `0x07` Home, `0x08` End, `0x09` PageUp, `0x0A` PageDown,
    `0x10`–`0x1B` F1–F12
## RX payload — v5 extensions (dongle-stored macros)

The dongle is the source of truth for user macros (flash-persisted, like bonds/name).
Any client connects and reads the same library.

- **Macro store characteristics** on the custom service (UUIDs registered in v5 firmware README):
  - MACRO_LIST (read, notify): JSON array `[{"i":0,"name":"SOAP note","len":412}, ...]`
  - MACRO_RW (write-with-response + read): chunked transfer —
    - Write: `{"op":"put","i":0,"name":"...","off":0,"data":"<utf8 chunk>"}`; chunks ≤180 B,
      `off` cumulative; final chunk has `"fin":true`. `{"op":"del","i":2}` deletes.
    - Read: `{"op":"get","i":0,"off":0}` → response/notify returns the same chunk shape.
  - Capacity: 16 macros, 16 KB total flash budget (documented; firmware rejects with error notify `0xE1` full).
- **Standalone trigger** (optional v5 feature): long-press (>1.5 s) the dongle button with no BLE
  connection plays macro index 0 over USB. Short press remains the pairing window.

## RX payload — v2 extensions (modifiers + relative mouse)
  - `0x00 0x81 <bitmask>` = sticky-arm modifiers for the NEXT key only (then auto-release)
  - `0x00 0x82 <bitmask>` = hold modifiers down until release
  - `0x00 0x83` = release all modifiers
  - Bitmask = HID report byte 0: bit0 LCtrl, bit1 LShift, bit2 LAlt, bit3 LGui,
    bit4 RCtrl, bit5 RShift, bit6 RAlt, bit7 RGui.
- **Mouse** (requires the composite HID descriptor; keyboard = report ID 1, mouse = report ID 2):
  - `0x00 0x90 <buttons> <dx> <dy> <wheel>` — buttons bit0 left/bit1 right/bit2 middle;
    dx, dy, wheel = signed int8 relative movement. Sent at touch-event rate; firmware clamps per-report deltas to int8 range.
- **Absolute pointer** (report ID 3, digitizer-class; Windows maps logical extent linearly to the screen — no pointer acceleration):
  - `0x00 0x91 <buttons> <x_lo> <x_hi> <y_lo> <y_hi>` — buttons as above; x, y = uint16 LE, 0..32767 normalized screen position.
  - Intended use: teleport/landmark clicks, drag-select with exact endpoints, tablet-style tracking.
    Calibration: verify-first (teleport to corners, user confirms); four-corner learn mode is the fallback for odd monitor mappings.

## TX notifications (status)

- `0x00` idle/ready, `0x01` busy typing, `0xE0`+ error codes (v1: best effort)

## Client UX requirements (any platform)

1. Scan/filter by NUS service UUID; name prefix `VoiceKB` as fallback. If the
   user has set a custom name via the config characteristic, match that stored
   name first, then the `VoiceKB` fallback.
2. Bond on first connect (Just Works pairing window after dongle button press).
3. Persist the bond; reconnects must not require the pairing window.
4. Live-typing mode should send each character/backspace as produced.
