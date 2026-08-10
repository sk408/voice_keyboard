# Voice Keyboard — web app

A PWA that turns your phone into a Bluetooth keyboard + mouse for your PC.
It connects over Web Bluetooth to an nRF52840 dongle (advertised as
`VoiceKB`) plugged into the PC; the dongle is a composite USB HID device
(keyboard + mouse) to the PC, so whatever you type, dictate, or gesture on
the phone appears on the PC. Voice input comes free from the phone
keyboard's dictation mic (e.g. Gboard).

The wire protocol is defined in [`../PROTOCOL.md`](../PROTOCOL.md) — this app
is a client of it.

## Browser requirements

- **Android Chrome** (or another Chromium with Web Bluetooth) — the main target.
- **Desktop Chrome/Edge** also work.
- HTTPS is required for Web Bluetooth (GitHub Pages qualifies; `localhost`
  works for development). Firefox and Safari do not support Web Bluetooth.

## Usage

### Connect & pair

1. Plug the dongle into the PC.
2. Open the app and tap **Connect**. The chooser shows only devices with the
   NUS service or a `VoiceKB` name prefix.
3. On the **first** connection the link must be paired (Just Works bonding).
   If pairing fails or the device won't connect, **press the button on the
   dongle** to open the 60-second pairing window, then tap Connect again.
4. After a successful pair the bond persists: reconnects don't need the
   button. Previously granted devices appear as one-tap **Reconnect** buttons
   (via `navigator.bluetooth.getDevices()`), no chooser needed.
5. If the bond on the phone/PC side gets out of sync, use **Forget**, then
   pair again from scratch.

The status bar shows connection state, paired state, and a typing-status
badge. The badge flips to **typing…** optimistically the moment a send is
queued (and back to **ready** when all queued sends complete), and the
dongle's TX notifications (`0x00` ready / `0x01` busy) drive it too. This
makes the two failure modes distinguishable when debugging: badge flips
but nothing is typed → the dongle side is dropping writes; badge never
flips → the app-side write path is broken.

On the first connection, pairing (Just Works) is triggered by the first
keystroke write — RX writes require an encrypted link, while the TX
subscription does not. If a send fails with a pairing error, press the
dongle button and retry within the 60-second window.

### Live mode

Everything you produce in the text field — typed characters, Backspace,
autocorrect rewrites, and **voice dictation from the keyboard mic** — is
diffed against the previous value and streamed to the PC as it happens
(backspaces + inserted text). Use this mode for dictation.

### Compose mode

Type, paste, or dictate a block of text, then tap **Send to PC** to type the
whole block out on the PC at once.

### Special keys bar

Esc, Tab, Enter, Backspace, arrow keys and Delete. Tab/Enter/Backspace go as
protocol bytes (`\t` / `\n` / `0x08`); the rest are sent as `0x00`-escaped
special key codes per PROTOCOL.md.

### Sticky modifiers (keyboard tab)

Ctrl, Shift, Alt and Gui buttons sit above the special keys bar. Each tap
cycles a modifier through three states, all visible on the button and in
the status line below the bar:

- **armed** (`next`) — applies to the *next* key or special key only: the
  key goes out prefixed with `0x00 0x81 <mask>` and the modifier disarms.
  Arm several modifiers to compose a chord (Ctrl + Shift armed, then T →
  `0x81` with mask `0x03`).
- **locked** (`hold`) — held down on the PC (`0x00 0x82 <mask>`) until
  released; affects everything typed/clicked while held.
- tap again → **off** (`0x00 0x82` with the remaining held set, or
  `0x00 0x83` release-all when the last one is released). **Clear**
  releases everything.

### Mouse tab

The **Mouse** tab is a full-width trackpad: one-finger drag moves the
pointer (0x90 packets, throttled to ~50/s), tap = left click, two-finger
tap = right click, two-finger drag = scroll wheel. Left/middle/right are
also available as hold-to-press on-screen buttons (hold Left while dragging
on the trackpad for drag-select). Switching tabs is pure view state — the
BLE connection is owned by the store and is never torn down.

## Install as a PWA (Android)

1. Open the deployed app in Chrome: `https://<user>.github.io/voice_keyboard/`.
2. Chrome menu (⋮) → **Add to Home screen** → **Install**.
3. Launch from the home screen icon ("Voice Keyboard"). The shell works
   offline after the first visit; BLE typing obviously needs the dongle.

## Development

```sh
npm install
npm run dev      # dev server (use --host to reach it from a phone; HTTPS required for BLE)
npm test         # vitest — protocol encoding unit tests
npm run build    # tsc --noEmit + vite build → dist/
```

Deployment is via GitHub Actions → GitHub Pages (see
`../.github/workflows/deploy.yml`); the Vite base is `/voice_keyboard/`.

## Layout

- `src/protocol.ts` — pure protocol encoding (chunking, escaping, edit diffs, v2 modifier/mouse packets); unit-tested.
- `src/ble.ts` — Web Bluetooth / NUS connection, write queue, error classification; queue unit-tested (`ble.test.ts`).
- `src/store.ts` — zustand app state (connection, mode, status, modifier state, errors).
- `src/components/` — status bar, mode toggle, live/compose inputs, sticky modifier bar, special keys bar, mouse trackpad.
- `public/` — manifest, service worker, icons (`scripts/gen_icons.py` regenerates them).
