# Voice Keyboard — web app

A PWA that turns your phone into a Bluetooth keyboard + mouse for your PC.
It connects over Web Bluetooth to an nRF52840 dongle (advertised as
`InputStick`) plugged into the PC; the dongle is a composite USB HID device
(keyboard + mouse + absolute pointer) to the PC, so whatever you type,
dictate, or gesture on the phone appears on the PC. Voice input comes free
from the phone keyboard's dictation mic (e.g. Gboard).

The wire protocol is the **InputStick packet protocol** defined in
[`../INPUTSTICK_EMULATION_SPEC.md`](../INPUTSTICK_EMULATION_SPEC.md) —
framed packets (`0x55` tag + block header + CRC32) over the Nordic UART
Service. This app is a client of it, same as the InputStick iOS/Android
apps. It requires dongle firmware **v6.0** or later; the v1–v5 raw
ASCII/escape protocol ([`../PROTOCOL.md`](../PROTOCOL.md)) is gone from both
sides.

## Browser requirements

- **Android Chrome** (or another Chromium with Web Bluetooth) — the main target.
- **Desktop Chrome/Edge** also work.
- HTTPS is required for Web Bluetooth (GitHub Pages qualifies; `localhost`
  works for development). Firefox and Safari do not support Web Bluetooth.

## Usage

### Connect

1. Plug the dongle into the PC.
2. Open the app and tap **Connect**. The chooser shows devices with the NUS
   service or an `InputStick` name prefix.
3. v6 needs no pairing or bonding — the link is plaintext NUS. On connect
   the app runs the InputStick handshake (RunFirmware → GetFirmwareInfo →
   SetUpdateInterval); a dongle that doesn't answer the handshake is running
   pre-v6 firmware and the connect fails with a clear error.
4. Previously granted devices appear as one-tap **Reconnect** buttons (via
   `navigator.bluetooth.getDevices()`), no chooser needed.

The status bar shows connection state, the dongle's firmware version, and a
typing-status badge. The badge flips to **typing…** optimistically the
moment a send is queued (and back to **ready** when all queued sends
complete), and the dongle's periodic `0x2F` HID-status notifications drive
it too. This makes the two failure modes distinguishable when debugging:
badge flips but nothing is typed → the dongle side is dropping writes; badge
never flips → the app-side write path is broken.

### Flow control

Every HID report the app sends debits a per-interface model of the dongle's
report buffers (keyboard 128 / mouse 64 / consumer 64, matching the
firmware's 256-deep shared HID queue). The dongle's `0x2F` status
notifications report how many reports per interface were drained to USB;
those replenish the model. A long dictation burst that would overrun the
dongle simply waits for the next status notification instead of losing
keystrokes.

### Live mode

Everything you produce in the text field — typed characters, Backspace,
autocorrect rewrites, and **voice dictation from the keyboard mic** — is
diffed against the previous value and streamed to the PC as it happens
(backspaces + inserted text). Use this mode for dictation.

Text is typed as USB HID keycodes on a **US keyboard layout** — the app maps
each character to `[modifiers, keycode]` (shift added for capitals and
symbols) and sends press/release report pairs as `HIDDataKeyboardShort`
(0x2C) packets. Characters a US keyboard can't type (emoji, accented
letters, CJK) are dropped.

### Compose mode

Type, paste, or dictate a block of text, then tap **Send to PC** to type the
whole block out on the PC at once.

### Special keys bar

Esc, Tab, Enter, Backspace, arrow keys and Delete. Tab/Enter/Backspace go
through the text path (they map to HID keycodes like any other character);
the rest are named special keys. Everything is sent as keyboard-short
packets.

### Sticky modifiers (keyboard tab)

Ctrl, Shift, Alt and Gui buttons sit above the special keys bar. Each tap
cycles a modifier through three states, all visible on the button and in
the status line below the bar:

- **armed** (`next`) — applies to the *next* key or special key only: the
  modifier bits ride that key's press report and the modifier disarms.
  Arm several modifiers to compose a chord (Ctrl + Shift armed, then T).
- **locked** (`hold`) — held down on the PC until released: the app sends a
  `[mask, 0]` keyboard-state report and includes the locked bits in every
  keystroke while held.
- tap again → **off** (a new `[mask, 0]` report with the remaining held set,
  or all-zero when the last one is released). **Clear** releases everything.

### Macros tab

Macros are named text templates with tokens (`{enter}`, `{ctrl+x}`, …),
fill-in fields (`{{name}}`) and clicks (`{click 50% 25%}`,
`{click "Save button"}`). **Run** types a macro through the dongle; Export /
Import move the library between phones as JSON.

Macros live on the phone (localStorage). Firmware v6 has no dongle-side
macro store — the v5 store was removed in v5.14 and the characteristics no
longer exist — so there is nothing to sync and no button macro.

### Mouse tab

The **Mouse** tab is a trackpad plus a dedicated scroll strip. The gesture
model:

- **One finger** uses the configured one-finger mode (Settings → One-finger
  trackpad mode):
  - **Absolute pointer** (default): the pad maps to the whole screen through
    the calibration map — the cursor tracks your finger like a tablet, and
    lifting + re-touching jumps the cursor (no deltas). Sent as
    `HIDDataTouchScreen` (0x26) packets (report ID 4) with the tip bit clear.
    Windows maps the absolute pointer's logical extent **linearly** to the
    screen — no pointer acceleration applies.
  - **Classic relative**: ordinary touchpad deltas (`HIDDataMouse` 0x23
    packets).
- **Two fingers** always give classic relative deltas ("fine control") from
  the cursor's current position, in either mode — the second finger never
  triggers an absolute jump, and lifting one finger of the pair keeps the
  gesture relative until the other lifts too, so disengaging never moves
  the cursor.
- **Scroll strip** (right edge): vertical drag = scroll wheel, natural
  direction (drag up = scroll up).
- **Left / Middle / Right** on-screen buttons are hold-to-press and click
  through the relative mouse (0x23); the trackpad itself never clicks, so
  the absolute pointer (0x26) tip bit stays clear.

All pointer packets are throttled to ~50/s. Switching tabs is pure view
state — the BLE connection is owned by the store and is never torn down.

### Pointer calibration (Settings)

Absolute mode needs to know how the host maps the 0..32767 normalized extent
onto the actual screen. The **Calibrate pointer** wizard (Settings → Pointer
calibration) is verify-first:

1. The cursor is teleported to the top-left corner through the current map;
   confirm it, then the same for bottom-right. Both confirmed → the current
   map is kept, done.
2. Any "No" starts **four-corner learn mode**: for each corner (top-left,
   top-right, bottom-left, bottom-right) drag on the wizard's pad until the
   host cursor sits exactly at that corner, then tap **Set corner**. After
   all four, a new map is derived and saved.

The map is persisted per device (keyed by the dongle's name) and reloaded on
connect.

### Landmarks (Mouse tab)

Below the mouse buttons: **Save current spot** stores the last-sent absolute
cursor position under a name (enabled once you've moved the pointer at least
once). Each landmark has **Go** (teleport), **Go + click** (teleport and
left-click at the spot), and **Delete**. Landmarks are stored per device and
can be used from macros:

- `{click 80% 90%}` — click at 80 % / 90 % of the screen (through the
  calibration map).
- `{click "Save button"}` — click at the named landmark. An unknown landmark
  stops the macro run with a warning instead of being silently skipped.

## Install as a PWA (Android)

1. Open the deployed app in Chrome: `https://<user>.github.io/voice_keyboard/`.
2. Chrome menu (⋮) → **Add to Home screen** → **Install**.
3. Launch from the home screen icon ("Voice Keyboard"). The shell works
   offline after the first visit; BLE typing obviously needs the dongle.

## Development

```sh
npm install
npm run dev      # dev server (use --host to reach it from a phone; HTTPS required for BLE)
npm test         # vitest — protocol encoding + BLE queue/flow-control unit tests
npm run build    # tsc --noEmit + vite build → dist/
```

Deployment is via GitHub Actions → GitHub Pages (see
`../.github/workflows/deploy.yml`); the Vite base is `/voice_keyboard/`.

## Layout

- `src/protocol.ts` — InputStick packet framing + CRC32, packet parser, US-layout text→keycode mapping, keyboard/mouse/touch/consumer packet builders, live-edit diffing, flow-control model; unit-tested.
- `src/ble.ts` — Web Bluetooth / NUS connection, InputStick handshake, serialized + paced write queue, 0x2F-driven flow control; queue unit-tested (`ble.test.ts`).
- `src/calibration.ts` — screen-fraction ↔ normalized mapping, four-corner calibration, per-device persistence; unit-tested.
- `src/landmarks.ts` — named absolute cursor spots, per-device persistence; unit-tested.
- `src/macroStorage.ts` — localStorage macro library + import/export.
- `src/macros.ts` — macro template tokenizer → InputStick packets; unit-tested.
- `src/store.ts` — zustand app state (connection, mode, status, modifier state, pointer mode, calibration, landmarks, macros, errors).
- `src/components/` — status bar, mode toggle, live/compose inputs, sticky modifier bar, special keys bar, mouse trackpad + scroll strip, landmarks, calibration wizard.
- `public/` — manifest, service worker, icons (`scripts/gen_icons.py` regenerates them).
