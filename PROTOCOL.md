# Voice Keyboard BLE Protocol v1

Contract between the nRF52840 dongle (BLE peripheral, USB HID keyboard toward PC)
and any central client (web app now; native Android/iOS apps later).

## Identity

- Advertising name: `VoiceKB`
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

Also standard DIS (0x180A) with Firmware Revision String = `vk-1.0`.

## RX payload (typing)

Stream of bytes, any chunking; dongle types as received, rate-limited (~15 ms/keystroke).

- Printable UTF-8 → typed on US keyboard layout (shift handling in firmware)
- `\n` → Enter, `\t` → Tab, `0x08` → Backspace
- `0x00` = escape: next byte is a special key:
  - `0x01` Esc, `0x02` Up, `0x03` Down, `0x04` Left, `0x05` Right,
    `0x06` Delete, `0x07` Home, `0x08` End, `0x09` PageUp, `0x0A` PageDown,
    `0x10`–`0x1B` F1–F12
  - Modifier combos (Ctrl/Alt/Gui+key) reserved for v2 (`0x00 0x80+...`)

## TX notifications (status)

- `0x00` idle/ready, `0x01` busy typing, `0xE0`+ error codes (v1: best effort)

## Client UX requirements (any platform)

1. Scan/filter by NUS service UUID; name prefix `VoiceKB` as fallback.
2. Bond on first connect (Just Works pairing window after dongle button press).
3. Persist the bond; reconnects must not require the pairing window.
4. Live-typing mode should send each character/backspace as produced.
