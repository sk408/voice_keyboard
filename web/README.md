# Voice Keyboard — web app

A PWA that turns your phone into a Bluetooth keyboard for your PC. It connects
over Web Bluetooth to an nRF52840 dongle (advertised as `VoiceKB`) plugged into
the PC; the dongle is a plain USB HID keyboard to the PC, so whatever you type
or dictate on the phone appears on the PC. Voice input comes free from the
phone keyboard's dictation mic (e.g. Gboard).

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

The status bar shows connection state, paired state, and the dongle's
typing-busy status (from TX notifications: `0x00` ready / `0x01` busy).

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

- `src/protocol.ts` — pure protocol encoding (chunking, escaping, edit diffs); unit-tested.
- `src/ble.ts` — Web Bluetooth / NUS connection, write queue, error classification.
- `src/store.ts` — zustand app state (connection, mode, status, errors).
- `src/components/` — status bar, mode toggle, live/compose inputs, special keys bar.
- `public/` — manifest, service worker, icons (`scripts/gen_icons.py` regenerates them).
