# Voice Keyboard firmware — nRF52840 dongle

Zephyr 4.1.0 application for the Nordic PCA10059 dongle (Adafruit UF2
bootloader). The dongle enumerates as a single composite USB HID device —
keyboard (report ID 1) + mouse (report ID 2) + absolute pointer
(report ID 3) in one report descriptor — and receives keystrokes, mouse
packets and absolute pointer packets over BLE NUS per
[`../PROTOCOL.md`](../PROTOCOL.md).

## Build

```sh
source ~/noahlink_emu/.venv/bin/activate        # west + cmake 3.31.6
export PATH="$HOME/.local/bin:$PATH"            # gperf
export ZEPHYR_SDK_INSTALL_DIR=~/zephyr-sdk-0.17.0

cd ~/noahlink_emu/zephyrproject
west build -b nrf52840dongle/nrf52840 ~/voice_keyboard/firmware \
    -d ~/voice_keyboard/firmware/build --pristine
```

Output: `~/voice_keyboard/firmware/build/zephyr/zephyr.uf2`.

## Flash

1. Plug the dongle in while pressing the reset button (or double-press it,
   depending on bootloader version) to enter UF2 bootloader mode — a USB
   mass-storage drive appears.
2. Drag `zephyr.uf2` onto the drive. The dongle reboots into the app.

The app is linked at `0x26000` (Adafruit bootloader layout: MBR + SoftDevice
below, bootloader at `0xF4000`) and does not touch the bootloader.

**v5 flash-layout change**: the settings storage partition moved from the
stock 16 KB at `0xDC000` to 32 KB at `0xB4000` (tail of the unused slot1
partition; the app is capped below it via `CONFIG_FLASH_LOAD_SIZE`) to make
room for the macro store next to bonds and the device name. Side effect of
flashing v5 over ≤v4: bonds and the custom name stored in the old partition
are not migrated — re-pair and re-set the name once.

## Behavior

- **USB**: single HID interface with a composite report descriptor:
  keyboard = input report ID 1 (8-byte report + ID byte, mods + 6-key
  array + LED output report), mouse = input report ID 2 (buttons +
  X/Y/wheel signed int8 + ID byte), absolute pointer = input report ID 3
  (digitizer-class: buttons + X/Y absolute uint16, logical 0..32767 + ID
  byte). Windows enumerates one USB device exposing all three functions;
  the absolute pointer maps linearly to the screen with no pointer
  acceleration. Because the descriptor uses report
  IDs, the interface claims **no boot protocol** (`protocol-code = "none"`)
  — the keyboard does not work in BIOS/UEFI/pre-boot environments.
- **BLE**: advertises as `VoiceKB` (default; user-settable, see below) with
  the NUS service UUID (`6E400001-...`). RX `6E400002-...` (write /
  write-no-resp, encrypted link required), TX `6E400003-...` (notify, status
  bytes). DIS firmware revision string: `vk-5.0`.
- **Config characteristic (v3)**: `5A1B0001-8C4D-4E2F-9A3B-7C6D5E4F3A2B`
  (read / write-with-response, encrypted link required) on the same service.
  Write a UTF-8 device name (1–20 printable ASCII chars) to rename the
  dongle: it is persisted via the settings subsystem and applied to the GAP
  Device Name immediately and to the advertising data on the next advertise
  (after disconnect). Read returns the current name. Invalid names are
  rejected (`Value Not Allowed`).
- **Macro store characteristics (v5)**: two more vendor characteristics on
  the same service, same vendor UUID base, both encrypted-link only:
  - MACRO_LIST `5A1B0002-8C4D-4E2F-9A3B-7C6D5E4F3A2B` (read + notify):
    JSON array of the stored macros, e.g.
    `[{"i":0,"name":"SOAP note","len":412}]` (`[]` when empty). A notify is
    sent whenever the store changes (put/del completes). Best effort: if the
    list outgrows the negotiated ATT MTU the notification is dropped — the
    full value can always be read from the characteristic.
  - MACRO_RW `5A1B0003-8C4D-4E2F-9A3B-7C6D5E4F3A2B` (write-with-response +
    read), chunked transfer:
    - Write `{"op":"put","i":0,"name":"...","off":0,"data":"..."}` — each
      ATT write carries ≤180 bytes of payload; `off` is the cumulative byte
      offset into the template; the final chunk adds `"fin":true`. `name`
      is only required on the first chunk (`off`=0). A new `off`=0 chunk
      restarts an interrupted put; a disconnect aborts it (staging
      discarded).
    - Write `{"op":"del","i":2}` deletes slot 2 (deleting an empty slot is
      a no-op).
    - Write `{"op":"get","i":0,"off":412}` prepares a read chunk; reading
      MACRO_RW then returns
      `{"op":"get","i":0,"off":412,"len":TOTAL,"data":"..."}` plus
      `"fin":true` when the chunk reaches the end. Responses are capped at
      180 bytes (a read with no preceding get returns `{}`).
  - JSON `data` encoding (client contract): the template is an arbitrary
    byte stream (UTF-8 text + pre-encoded `0x00` escape tokens). Printable
    safe ASCII passes through; every other byte — control bytes incl. the
    `0x00` escape marker, and bytes ≥0x80 — is encoded as one `\u00XX`
    escape per raw byte (uppercase hex), plus the standard JSON escapes
    `\"` and `\\`. The result is strict JSON in both directions (the
    firmware's get responses use the same encoding). Chunk boundaries may
    fall anywhere in the byte stream (mid-UTF-8 character,
    mid-escape-sequence): the firmware unescapes each chunk at the byte
    level and appends the raw bytes, never interpreting UTF-8.
  - Capacity: 16 slots (indices 0–15), name ≤24 bytes each, 16 KB total
    store budget. A put that would exceed the budget is rejected: the write
    fails with an ATT error and error notify `0xE1` is sent on the NUS TX
    characteristic. An empty template (`fin` with no data) deletes the slot.
  - Persistence: settings/NVS under `vkbm/<i>/n` (name) and
    `vkbm/<i>/t/<k>` (template chunks of 2 KB — one NVS record must fit a
    4 KB flash sector). Chunks are validated and reassembled at boot;
    a partial/corrupt set (e.g. power loss mid-commit) drops the slot.
- **Macro playback (v5)**: playing a stored macro feeds its template bytes
  through the same typing-engine path as NUS RX bytes — tokens/escapes are
  stored pre-encoded by the client, the dongle just types the byte stream.
  **Standalone trigger**: a long press (>1.5 s) of the dongle button while
  no BLE connection is active plays macro slot 0 over USB. Short press
  remains the 60 s pairing window (unchanged, also while connected). If
  slot 0 is empty, a long press does nothing.
- **Typing**: RX bytes are reassembled as a byte stream (robust to any BLE
  chunking, including escape sequences split across chunk boundaries) and
  typed on a US layout at ~15 ms/keystroke. Shift handling for
  capitals/symbols is done in firmware. `\n` = Enter, `\t` = Tab, `0x08` =
  Backspace, `0x00`-escaped special keys per the protocol.
- **Modifiers (v2)**: `0x00 0x81 <mask>` arms sticky modifiers for the next
  keystroke (then auto-release), `0x00 0x82 <mask>` holds modifiers down
  (pressed immediately, so they also modify host-side mouse clicks),
  `0x00 0x83` releases all. The mask is the HID modifier byte. Held and
  sticky modifiers compose with each other and with the keystroke's own
  shift handling. A BLE disconnect while modifiers are held releases them
  on the host.
- **Mouse (v2)**: `0x00 0x90 <buttons> <dx> <dy> <wheel>` emits a mouse
  report (report ID 2); buttons bit0 left / bit1 right / bit2 middle, deltas
  clamped to the descriptor range −127..127. Mouse packets bypass the
  keystroke rate limit.
- **Absolute pointer (v4)**: `0x00 0x91 <buttons> <x_lo> <x_hi> <y_lo>
  <y_hi>` emits an absolute pointer report (report ID 3, digitizer-class
  Touch Screen application collection); buttons as for the mouse, x/y =
  uint16 LE 0..32767 normalized screen position. Absolute pointer packets
  bypass the keystroke rate limit.
- **Status**: TX notifies `0x01` (busy) while the keystroke queue is being
  typed, `0x00` (idle) when drained. Best effort.
- **LED** (green LED0): slow blink = advertising, solid = connected.
  Red debug LED1 blink codes (see DEBUG_NOTES.md): 1 = RX write, 2 = first
  report clocked out, 3 = HID submit failed/not ready, solid 1 s = HID
  interface ready, 4 = mouse packet received, 5 = absolute pointer packet
  received, 6 = macro playback started. At boot the red LED also runs a
  stage trace (1→5 blinks in slow groups: main, USB up, BLE up, settings
  loaded, advertising up) — the last group seen pinpoints a boot hang.
  Long (400 ms) blinks are boot sub-stages on the bt_enable() path, and
  repeating patterns signal unrecoverable boot errors or hard faults —
  see DEBUG_NOTES.md (v5.2) for the full table.

## Pairing / security

- LE bonding (Just Works) is required: RX writes need an encrypted link.
- The dongle is **bondable only for 60 s after a single press of the onboard
  button**. Press the button, then pair from the central.
- Outside the window, only already-bonded centrals may connect; unbonded
  peers are disconnected. An unbonded peer still connected when the window
  expires is disconnected too.
- Bond keys are persisted in flash (settings subsystem, `storage` partition),
  so reconnects after reboot do not need the pairing window.
- To re-pair a central, press the button again to reopen the window.

## Known limitations

- **Non-ASCII input is dropped.** The protocol's "printable UTF-8" is
  honored for the ASCII range only; characters outside US-ASCII (e.g. é, ü,
  CJK) cannot be produced on a plain US HID layout and are silently skipped
  (multi-byte UTF-8 sequences are dropped byte-wise).
- **USB VID/PID** is `0x1209/0x0001` (pid.codes community VID). The PID is
  not officially registered; fine for personal use, not for distribution.
- **No HID boot protocol**: the composite keyboard+mouse descriptor uses
  report IDs, so the keyboard is unavailable in BIOS/UEFI and other
  pre-boot environments that only speak boot protocol.
- Only one BLE connection at a time (Zephyr default `CONFIG_BT_MAX_CONN=1`).
- HID output reports (host-driven Num/Caps/Scroll Lock LEDs) are accepted
  but ignored — the dongle LED reflects BLE state instead.
- Logs go to SEGGER RTT (viewable with a J-Link); there is no UART console.

## Layout

```
firmware/
├── CMakeLists.txt
├── prj.conf                              # UF2 offset, USB HID, BLE, SMP, settings
├── boards/
│   └── nrf52840dongle_nrf52840.overlay   # zephyr,hid-device node
└── src/
    ├── main.c      # init, LED state machine, pairing button (debounced)
    ├── usb_kbd.c   # usbd (next stack) setup + composite HID keyboard+mouse+abs pointer
    ├── ble.c       # NUS-compatible GATT service, config char (v3), adv, bonding window, gating
    ├── typing.c    # RX byte stream -> HID reports, US keymap, v2/v4 escapes
    └── vkb.h       # internal interfaces
```

The built-in Zephyr NUS service is **not** used: its RX characteristic
allows unencrypted writes, while the protocol requires an encrypted link.
`ble.c` defines an identical-UUID service with `BT_GATT_PERM_WRITE_ENCRYPT`.
