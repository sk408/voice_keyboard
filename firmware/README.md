# Voice Keyboard firmware — nRF52840 dongle (v6.0)

Zephyr 4.1.0 application for the Nordic PCA10059 dongle (Adafruit UF2
bootloader). The dongle enumerates as a single composite USB HID device —
keyboard (report ID 1) + mouse (report ID 2) + absolute pointer
(report ID 3) in one report descriptor — and, over BLE NUS, speaks the
**InputStick packet protocol** so the free InputStick iOS/Android apps
connect, reach "Ready", and type (see
[`../../INPUTSTICK_EMULATION_SPEC.md`](../../INPUTSTICK_EMULATION_SPEC.md)).

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

**Storage partition**: settings/NVS lives at `0xB4000` (32 KB, tail of the
unused slot1 partition; the app is capped below it via
`CONFIG_FLASH_LOAD_SIZE`). v6.0 stores no bonds, but the partition and the
v5.2 mount/repair path stay so a flash of garbage at that address can never
abort `bt_enable()`.

## Behavior

- **USB**: single HID interface with a composite report descriptor:
  keyboard = input report ID 1 (8-byte report + ID byte, mods + 6-key
  array + LED output report), mouse = input report ID 2 (buttons +
  X/Y/wheel signed int8 + ID byte), absolute pointer = input report ID 3
  (absolute-pointer class: buttons + X/Y absolute uint16, logical 0..32767 + ID
  byte). Windows enumerates one USB device exposing all three functions;
  the absolute pointer maps linearly to the screen with no pointer
  acceleration. Because the descriptor uses report
  IDs, the interface claims **no boot protocol** (`protocol-code = "none"`)
  — the keyboard does not work in BIOS/UEFI/pre-boot environments.
- **BLE**: advertises as `InputStick` with the NUS service UUID
  (`6E400001-...`). RX `6E400002-...` (write / write-no-resp, **plain** —
  no encryption/pairing), TX `6E400003-...` (notify, InputStick packets).
  DIS firmware revision string: `vk-6.0`.
- **Protocol**: the InputStick packet protocol (see the spec §3/§4):
  `0x55` tag, 16-byte-block header with response/encrypt/HMAC flags, CRC32
  (IEEE 802.3) over command+param+data, zero-padded to a multiple of 16.
- **Handshake** (§5 + §9b): replies to `RunFirmware` (0x04) and
  `GetFirmwareInfo` (0x10, reports firmware version 100, no password),
  `CMD_INIT` (0x11, Android), and `SetUpdateInterval` (0x31); then emits one
  `HIDStatusNotification` (0x2F) reporting `USBConfigured` so the app reaches
  "Ready".
- **HID mapping** (§6): `HIDDataKeyboardShort` (0x2C, 2-byte
  `[modifiers, keycode]`) is the dictation path — each report is typed as a
  press→release tap. `HIDDataKeyboard` (0x21, 8-byte) forwards
  `[mods, key0]` (single-key rollover), `HIDDataMouse` (0x23) forwards
  `[buttons, dx, dy, scroll]`, and `HIDDataTouchScreen` (0x26) forwards
  `[reportID, tip, x, y]` to the absolute pointer (16-bit x/y scaled to
  15-bit). Unimplemented commands get a `RESP_OK (0x01)` when the response
  flag is set, else are ignored.
- **Status / flow control**: M2 sends only the single Ready notification;
  the periodic (400 ms) `HIDStatusNotification` + drain counter + report
  buffer that complete the flow-control contract are M3 (TODO).
- **LED** (green LED0): slow blink = advertising, solid = connected.
  Red debug LED1 blink codes (see DEBUG_NOTES.md): 1 = RX write, 2 = first
  report clocked out, 3 = HID submit failed/not ready, solid 1 s = HID
  interface ready, 4 = mouse report received, 5 = absolute pointer report
  received, 9 = TX subscribed; v6.0 adds 11 = packet CRC mismatch (200ms x2),
  12 = control packet dispatched (200ms x3), 13 = Ready notification sent
  (200ms x4). At boot the red LED also runs a stage trace (1→5 blinks in
  slow groups: main, USB up, BLE up, settings loaded, advertising up), plus
  long (400 ms) sub-stage markers and repeating patterns for unrecoverable
  errors — see DEBUG_NOTES.md (v5.2).

## Pairing / security

None. v6.0 is plain NUS: the InputStick apps connect and write unencrypted,
no bonding, no MITM, no pairing window (see the spec §2/§9.1). The onboard
button does nothing.

## Known limitations

- **Flow control is incomplete (M2).** Without the periodic
  `HIDStatusNotification` + drain counter (M3), a long dictation burst will
  eventually stop once the app's remote-buffer free-space counter reaches
  zero. Short bursts type fine.
- **USB VID/PID** is `0x1209/0x0001` (pid.codes community VID). The PID is
  not officially registered; fine for personal use, not for distribution.
- **No HID boot protocol**: the composite keyboard+mouse descriptor uses
  report IDs, so the keyboard is unavailable in BIOS/UEFI and other
  pre-boot environments that only speak boot protocol.
- Only one BLE connection at a time (Zephyr default `CONFIG_BT_MAX_CONN=1`).
- HID output reports (host-driven Num/Caps/Scroll Lock LEDs) are accepted
  but ignored — the dongle LED reflects BLE state instead.
- Consumer/System/Gamepad reports, encryption/AES/HMAC, keygen, bootloader
  and firmware update are not implemented (later milestones).
- Logs go to SEGGER RTT (viewable with a J-Link); there is no UART console.

## Layout

```
firmware/
├── CMakeLists.txt
├── prj.conf                              # UF2 offset, USB HID, BLE, settings
├── boards/
│   └── nrf52840dongle_nrf52840.overlay   # zephyr,hid-device node + storage partition
└── src/
    ├── main.c        # init, LED state machine, button (debounced, no-op)
    ├── usb_kbd.c     # usbd (next stack) setup + composite HID kbd+mouse+abs pointer
    ├── ble.c         # plain NUS GATT service, adv, notify queue, NVS repair
    ├── inputstick.c  # InputStick packet layer + handshake + HID mapping
    └── vkb.h         # internal interfaces
```

The built-in Zephyr NUS service is **not** used; `ble.c` defines an
identical-UUID service so the RX characteristic is plain `BT_GATT_PERM_WRITE`
and the attribute layout stays explicit.
