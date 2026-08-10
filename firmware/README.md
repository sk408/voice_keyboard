# Voice Keyboard firmware — nRF52840 dongle

Zephyr 4.1.0 application for the Nordic PCA10059 dongle (Adafruit UF2
bootloader). The dongle enumerates as a standard USB HID keyboard (boot
protocol) and receives keystrokes over BLE NUS per
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

## Behavior

- **USB**: single HID keyboard interface, boot-protocol compatible. No vendor
  interfaces. Enumerates on Windows/Android hosts as a plain keyboard.
- **BLE**: advertises as `VoiceKB` with the NUS service UUID
  (`6E400001-...`). RX `6E400002-...` (write / write-no-resp, encrypted link
  required), TX `6E400003-...` (notify, status bytes). DIS firmware revision
  string: `vk-1.0`.
- **Typing**: RX bytes are reassembled as a byte stream (robust to any BLE
  chunking, including a `0x00` escape byte at a chunk boundary) and typed on
  a US layout at ~15 ms/keystroke. Shift handling for capitals/symbols is
  done in firmware. `\n` = Enter, `\t` = Tab, `0x08` = Backspace,
  `0x00`-escaped special keys per the protocol.
- **Status**: TX notifies `0x01` (busy) while the keystroke queue is being
  typed, `0x00` (idle) when drained. Best effort.
- **LED** (green LED0): slow blink = advertising, solid = connected.

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
- Modifier combos (`Ctrl`/`Alt`/`Gui` + key) are protocol-reserved for v2 and
  not implemented.
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
    ├── usb_kbd.c   # usbd (next stack) setup + boot-protocol HID keyboard
    ├── ble.c       # NUS-compatible GATT service, adv, bonding window, gating
    ├── typing.c    # RX byte stream -> HID reports, US keymap, rate limit
    └── vkb.h       # internal interfaces
```

The built-in Zephyr NUS service is **not** used: its RX characteristic
allows unencrypted writes, while the protocol requires an encrypted link.
`ble.c` defines an identical-UUID service with `BT_GATT_PERM_WRITE_ENCRYPT`.
