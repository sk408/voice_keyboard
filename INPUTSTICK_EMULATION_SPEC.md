# InputStick Emulation Spec — v6.0 (proposal)

**Goal:** make our nRF52840 voice-keyboard dongle appear to the free, already-approved
**InputStick iOS app** as a genuine InputStick device, so iPhone users get remote control,
macros, *and real-time dictation* (app does mic→text on-phone, sends keystrokes over BLE,
dongle types them into the PC) — with **zero App Store involvement**.

**Status:** protocol fully reverse-documented from the open-source `InputStickAPI-iOS`
(2019, Jakub Zawadzki). ~90% complete; the remaining 10% (exact firmware-info + status
packet full byte layouts) is flagged under *Open questions* and can be closed by capturing
a real InputStick or iterative trial against the app.

---

## 1. The decisive finding

InputStick is **not** classic Bluetooth and **not** MFI. It is a **plain BLE GATT
peripheral speaking the Nordic UART Service** — the exact NUS we already implement:

| Layer | InputStick | Our v5.14 dongle |
|---|---|---|
| Service | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` (NUS) | ✅ same |
| RX (phone→dongle write) | `6E400002-...` | ✅ same |
| TX (dongle→phone notify) | `6E400003-...` | ✅ same |
| Legacy fallback | `0000FFE0` service / `FFE1` char (HM-10) | not needed |
| Device name | `InputStick` | change from `VoiceKB` |

The BLE transport is already done. The work is a **packet protocol layered on top of NUS**.

## 2. Critical difference: no encryption, no bonding

Our v5.3→v5.8 added LE bonding + forced encryption + a 60 s pairing window (that whole
saga was needed for the *web app* on Chrome). **The InputStick iOS app does none of
that** — it connects and writes plaintext, no pairing, no MITM protection, no bond.

So the emulation firmware must **strip all encryption/bonding machinery**:

- Remove `bt_conn_set_security` forced encryption (v5.7).
- Remove DisplayYesNo numeric-comparison pairing (v5.8).
- Remove the bonded-peer gate + bondless recovery + pairing window (v5.3).
- RX characteristic becomes `BT_GATT_PERM_WRITE` (plain), not `..._WRITE_ENCRYPT`.
- No `BT_GATT_PERM_WRITE_ENCRYPT` anywhere.

This is a **simplification** — closer to v2 (plain NUS) than to v5.14. It also means the
v5.3-v5.8 encryption work stays in git history but is *not* in the emulation build.

## 3. Packet protocol (from `InputStickPacket.m`, `InputStickTxPacket.m`, `NSData+CRC.m`)

### 3.1 Framing

Every packet (both directions) on the NUS TX/RX chars:

```
byte 0        : 0x55 (start tag)
byte 1        : header = (length_in_16byte_blocks) | flags
bytes 2..N-1  : payload, total length padded up to a multiple of 16
```

- Header flags (OR into byte 1):
  - `0x20` HMAC present
  - `0x40` encrypted (AES-128)
  - `0x80` response requested (sender wants a reply)
- Length field = `header & 0x3F` = number of 16-byte blocks.
- `InputStickPacketMaxLength = 17 * 16 = 272` bytes.

### 3.2 Payload layout

```
[0..3]   CRC32 (big-endian) over bytes[4..end]
[4]      command (InputStickCmd)
[5]      param / response-code  (notifications have no param; see DataOffset)
[6..]    data
```

- `InputStickPacketDataOffset = 6` (normal packets: command, param, then data).
- `InputStickPacketNotificationDataOffset = 5` (notification packets: command, then data —
  no param byte; respCode is synthesized as `0x01` on the receive side).
- Payload is **zero-padded** to a multiple of 16 (`totalLength = ((payloadLength-1)>>4 + 1)*16`).

### 3.3 CRC32

Standard **CRC-32 / IEEE 802.3** (the "zlib" crc32):

- polynomial `0xEDB88320` (reflected), init `0xFFFFFFFF`, reflected in/out,
  final XOR `0xFFFFFFFF`.
- Computed over `bytes[4 .. totalLength-1]` (i.e. everything *after* the CRC field).
- Stored **big-endian** in bytes[0..3].

Zephyr provides this directly as **`crc32_ieee()`** (`<zephyr/sys/crc.h>`) — no table to
write. Verify against a known vector during bring-up (e.g. crc32("123456789") = 0xCBF43926).

## 4. Command set (`InputStickCmd`)

| Cmd | Hex | Meaning |
|---|---|---|
| Identify | 0x01 | respond (used for "find device" LED) |
| RunBootloader | 0x03 | enter bootloader (ignore) |
| RunFirmware | 0x04 | **handshake step 1** — respond |
| GetBootloaderInfo | 0x05 | respond (ignore/unused) |
| GetFirmwareInfo | 0x10 | **handshake step 2** — respond with fw info |
| WdgReset | 0x11 | watchdog-reset notify (ignore) |
| Authenticate | 0x12 | password auth (not used — no password) |
| SetValue | 0x14 | config write (ignore for v1) |
| RestoreDefaults | 0x15 | ignore |
| GetValue | 0x17 | config read (ignore) |
| SetPIN | 0x18 | ignore |
| USBResume | 0x19 | wake USB (ignore/no-op) |
| USBPower | 0x1A | ignore |
| SetName | 0x1C | rename device (optional) |
| ErrorNotification | 0x1E | notification (dongle→app) |
| SystemNotification | 0x1F | notification (dongle→app) |
| HIDRequestStatusReport | 0x20 | reply with HIDStatusNotification |
| HIDDataKeyboard | 0x21 | **8-byte keyboard report** |
| HIDDataConsumer | 0x22 | consumer/media report |
| HIDDataMouse | 0x23 | 4-byte mouse report |
| HIDDataGamepad | 0x24 | gamepad report |
| HIDDataMixed | 0x25 | mixed HID (ignore v1) |
| HIDDataTouchScreen | 0x26 | absolute pointer report |
| HIDDataRaw | 0x27 | raw HID (ignore v1) |
| HIDDataRawPoll | 0x28 | ignore v1 |
| HIDClear | 0x2A | clear a HID buffer |
| HIDDataEndpoint | 0x2B | raw endpoint write (gamepad path) |
| HIDDataKeyboardShort | 0x2C | **2-byte keyboard report (dictation path)** |
| HIDDataKeyboardPressAndRelease | 0x2D | press+release |
| HIDDataQueue | 0x2E | queued HID (ignore v1) |
| HIDStatusNotification | 0x2F | **notification: USB state + buffer drain (dongle→app)** |
| AuthenticateHMAC | 0x30 | not used (no password) |
| SetUpdateInterval | 0x31 | set status-notify interval (param = 100 ms units) |
| GetStatus | 0x32 | reply with status |
| KeygenGenerate/Test/Verify/Notification | 0x33–0x36 | TOTP keygen (ignore — no password) |
| HID*NoHMAC variants | 0x40–0x4E | same as 0x20–0x2E but never HMAC-signed |

## 5. Handshake (from `InputStickHIDFirmwareManager.m`)

The app drives this automatically after characteristic discovery:

1. App connects → discovers NUS → subscribes to TX notify (`6E400003`) → state `Initializing`.
2. App sends **`RunFirmware` (0x04)** with `requiresResponse` flag.
   → dongle replies with a `RunFirmware` packet, respCode `0x01`.
3. App sends **`GetFirmwareInfo` (0x10)** with `requiresResponse`.
   → dongle replies with firmware-info packet (see §5.1).
4. App sees `passwordProtectionEnabled == false` → skips auth → `didAuthenticate()`.
5. App sends **`SetUpdateInterval` (0x31)** param `0x04` (400 ms), no response — *only if
   fw version ≥ 100*.
6. App waits for **`HIDStatusNotification` (0x2F)** reporting USB state `USBConfigured
   (0x05)` → state `Ready`. Only now will it send HID data.
7. Dongle must keep sending `HIDStatusNotification` periodically (every 400 ms, and on
   buffer-drain changes) so the app's remote-buffer accounting stays correct.

**Dongle-side handshake responsibilities:**
- Reply to `RunFirmware` (respCode 0x01).
- Reply to `GetFirmwareInfo` with a valid fw-info packet.
- Optionally reply to `HIDRequestStatusReport` / `GetStatus`.
- Periodically emit `HIDStatusNotification` with USB state + buffer drain counts + LED
  state (see §6).

### 5.1 Firmware-info packet (response to GetFirmwareInfo)

Field map reconstructed by cross-referencing iOS (`InputStickRxPacket+FirmwareInfo.m`)
**and** Android (`DeviceInfo.java`), which index the payload at offset +1 relative to
iOS (Android strips CRC, then treats `data[0]=cmd, data[1]=param`). Aligned, the
firmware-info payload (bytes after command + respCode) is:

| offset | field | notes |
|---|---|---|
| `data[0]` | firmwareType | Android reads it; iOS ignores. Best guess 0/1 (BT2.0 vs BT4.0) — confirm |
| `data[1]` | versionMajor | iOS `data[1]`, Android `data[3]` |
| `data[2]` | versionMinor | iOS `data[2]`, Android `data[4]` |
| `data[3]` | versionHardware | Android `data[5]`; iOS ignores |
| `data[4..16]` | reserved | zero-fill |
| `data[17]` | securityStatus | bit 0x08 unlocked, bit 0x10 authenticated (iOS `data[17]` = Android `data[19]`) |
| `data[18]` | passwordProtection | 0/1 (iOS `data[18]` = Android `data[20]`) |

**We send (≥ 19 data bytes):**
- `data[1] = 1`, `data[2] = 0` → firmware version **100** (≥ 100 → sends
  SetUpdateInterval, enables HMAC; *no* keygen since keygen needs ≥ 101; no update nag).
- `data[0] = 1` (firmwareType — confirm), `data[3] = 0` (versionHardware).
- `data[17] = 0x00`, `data[18] = 0x00` (no password protection → both apps skip auth).
- Remaining bytes zero-filled.

## 6. HID report formats (from `InputStickHIDReport.m` + handlers)

HID data commands carry **`param = number of reports`**, and the data is the concatenation
of N fixed-size reports:

| Report | Cmd | Size | Layout |
|---|---|---|---|
| Keyboard short | `HIDDataKeyboardShort` 0x2C | 2 B | `[modifiers, keycode]` |
| Keyboard full | `HIDDataKeyboard` 0x21 | 8 B | `[modifiers, 0x00, key0..key5]` |
| Mouse | `HIDDataMouse` 0x23 | 4 B | `[buttons, dx, dy, scroll]` |
| Consumer | `HIDDataConsumer` 0x22 | 3 B | `[reportID, usage_lsb, usage_msb]` |
| System | `HIDDataConsumer` 0x22 | 3 B | reportID `0x02` |
| Touchscreen | `HIDDataTouchScreen` 0x26 | 6 B | `[reportID, tip+in_range, x_lsb, x_msb, y_lsb, y_msb]` |
| Gamepad | `HIDDataGamepad` 0x24 | 7 B | `[reportID, b_lsb, b_msb, x, y, z, rx]` |

Report IDs: Consumer `1`, System `2`, Gamepad `3`, TouchScreen `4`.

**Mapping to our USB HID (all already exist):**
- `HIDDataKeyboardShort` → `usb_kbd_report(modifiers, keycode)` — **this is the dictation
  path** (the app's `typeText:` uses short reports).
- `HIDDataKeyboard` → `usb_kbd_report(modifiers, key0)` (single-key rollover; ignore key1..5).
- `HIDDataMouse` → `usb_mouse_report(buttons, dx, dy, scroll)`.
- `HIDDataTouchScreen` → `usb_abs_report(tip?1:0, x_msb<<8|x_lsb, y_msb<<8|y_lsb)`.
  Note: InputStick x/y are 16-bit (0..65535); ours are 0..32767 — scale or extend the
  descriptor.
- Consumer/System/Gamepad → not implemented in our USB HID today. **v1: stub/ignore.**
  Later: add a consumer-control report (media keys) if wanted.

### 6.1 Remote buffer flow control (the subtle part)

The app maintains a **remote-buffer free-space counter** per interface. It will stop sending
once `freeSpace == 0`, and only replenish `freeSpace` when a `HIDStatusNotification` reports
`reportsSentToHost`. So the dongle **must**:

1. Buffer incoming HID reports per interface (keyboard/mouse/consumer).
2. Drain them to USB (our existing 4 ms HID poll).
3. Count drained reports since the last notification.
4. Emit `HIDStatusNotification` (every `SetUpdateInterval` = 400 ms) with the drain counts.

Without step 4, the app types a burst then freezes. This is the flow-control contract.

## 7. HIDStatusNotification layout (dongle→app)

Reconstructed from iOS (`InputStickHIDBuffersState.m` + `InputStickKeyboardLEDsState.m`)
**and** Android (`HIDInfo.java`). Offsets are from the byte right after the `0x2F`
command (iOS notification payload = Android payload minus the cmd/param bytes). Both
agree; Android adds the report-protocol flags and a `0xFF` marker:

| offset | field | notes |
|---|---|---|
| `data[0]` | USB state (see §8) | iOS `data[0]` = Android `data[1]` |
| `data[1]` | keyboard LEDs | bit0 numLock, bit1 capsLock, bit2 scrollLock |
| `data[2]` | keyboard report protocol | 1 = active (Android reads) |
| `data[3]` | keyboard buffer empty | non-zero = empty/ready |
| `data[4]` | mouse report protocol | 1 = active |
| `data[5]` | mouse buffer empty | non-zero = empty |
| `data[6]` | consumer buffer empty | non-zero = empty |
| `data[7]` | keyboard reports sent to host | since last notify |
| `data[8]` | mouse reports sent | |
| `data[9]` | consumer reports sent | |
| `data[11]` | `0xFF` marker | **required** — Android only reads the sent-to-host counts when this is `0xFF` |

**We send (≥ 12 bytes):** `data[0]=0x05`, `data[1]=0x00`, `data[2]=0x01`,
`data[3]=0x01`, `data[4]=0x01`, `data[5]=0x01`, `data[6]=0x01`, drain counts in
`data[7..9]`, `data[11]=0xFF`. Zero-fill the rest.

## 8. USB state enum

| Value | State |
|---|---|
| 0x00 | USBDisconnected |
| 0x01 | USBAttached |
| 0x02 | USBPowered |
| 0x03 | USBSuspended |
| 0x04 | USBAddressed |
| 0x05 | **USBConfigured** (ready — this is what we report) |

Our dongle already knows this: `usb_kbd_ready()` (host configured HID). Report `0x05`
once USB enumerates, `0x03` on suspend if we ever implement sleep.

## 9. Firmware implementation plan (v6.0)

New branch from `d18c6a7` (v5.14). Firmware speaks the InputStick protocol only; the web
app is rewritten as a client of that same protocol (see §9c), not maintained as a
separate legacy protocol.

### 9.1 Strip (revert encryption/bonding to plain NUS)
- `ble.c`: drop `bt_conn_set_security` call, pairing window, bondless-recovery gate,
  bonded-peer reject, `BT_GATT_PERM_WRITE_ENCRYPT` → `BT_GATT_PERM_WRITE`.
- `prj.conf`: disable pairing/bonding config (DisplayYesNo etc.) — or leave harmless but
  unused; cleanest to remove.
- Change advertising name → `InputStick` (and GAP name). Verify it still advertises the
  NUS service UUID128 (it does).

### 9.2 New module `inputstick.c` (+ `.h`)
- `inputstick_feed(const void *buf, uint16_t len)` — byte-wise parser (mirror of
  `InputStickPacketParser.m`): scan for `0x55` tag → read header → accumulate
  `(header & 0x3F)*16` payload bytes → verify CRC32 → dispatch command.
- `inputstick_send(cmd, param, data, len)` — build packet (CRC32, command, param, data,
  pad to 16), send via `bt_gatt_notify` on NUS TX **from the system workqueue** (the v5.4
  rule: never notify from the BT RX thread).
- `inputstick_respond(cmd, resp_code, data, len)` — response packet helper.
- Command dispatch table (§4). v1 implements: RunFirmware, GetFirmwareInfo,
  HIDDataKeyboardShort, HIDDataKeyboard, HIDDataMouse, HIDDataTouchScreen,
  HIDClear, HIDRequestStatusReport, SetUpdateInterval, GetStatus. Everything else → ignore.
- HID report buffer per interface + drain-to-USB + drain counter + 400 ms status timer.

### 9.3 Wire the HID mapping (§6) to existing `usb_kbd_report` / `usb_mouse_report` /
`usb_abs_report`.

### 9.4 Keep
- NUS service + TX/RX UUIDs (unchanged).
- USB HID composite (keyboard + mouse + absolute pointer).
- Workqueue-notify rule, LED trace (repurpose for debug), NVS repair.

### 9.5 Build / deliver
- `west build -b nrf52840dongle/nrf52840`, UF2 at `firmware/build/zephyr/zephyr.uf2`.
- Bump DIS rev → `vk-5.15` (prj.conf + README). Update DEBUG_NOTES.md.
- Commit on main, push, scp uf2 → `C:\Users\Steve\Downloads\voice_keyboard_v5.15.uf2`.

## 9b. Android coverage (InputStickAPI-Android)

Same wire protocol, verified byte-for-byte against `Packet.java` / `PacketManager.java`:
`0x55` tag, `0x80`/`0x40`/`0x20` flags, 16-byte subpackets, CRC32 (`java.util.zip.CRC32`
= IEEE 802.3). HID report formats identical (short-kbd 2B, full-kbd 8B with reserved
byte at [1], mouse 4B, consumer 3B, touchscreen 6B reportID 4, gamepad 7B reportID 3).

**Two Android transports** (`BTService.java`):
- `BT20Connection` — classic Bluetooth SPP/RFCOMM (UUID `00001101`). **nRF52840 cannot
do classic BT.** Legacy BT2.0 hardware only; not emulatable, not needed.
- `BT40Connection` — BLE, auto-detects **NRF** (our `6E400001/2/3` UUIDs) vs **HM-10**
(`0000FFE0`/`FFE1`). This is the modern InputStick (BT4.0) and the path both iOS and
Android apps use. **Our emulation targets this path.**

**Handshake differences (Android `BasicInitManager`) — must handle both:**
1. `RunFirmware (0x04)` → reply. (both)
2. `GetFirmwareInfo (0x10)` → reply with firmware info. (both)
3. **`CMD_INIT (0x11)` → reply RESP_OK** — Android sends this, iOS does **not**. (iOS
treats 0x11 as a dongle→app `WdgReset` notification; we only ever *receive* 0x11 from
Android and respond, so no conflict.)
4. `SetUpdateInterval (0x31)` → Android param 5 (500 ms) **with** response flag; iOS
param 4 (400 ms) **without**. Reply RESP_OK when the flag is set.
5. Emit `HIDStatusNotification (0x2F)` with `data[0]=0x05`. (both)

Command-name reconciliation: Android `CMD_INIT (0x11)` = iOS `CmdWdgReset (0x11)`,
`CMD_INIT_AUTH (0x12)` = iOS `CmdAuthenticate (0x12)`. Android adds `CMD_INIT_CON (0x13)`,
`CMD_LED (0x02)`, `CMD_RESTORE_STATUS (0x16)`, bootloader cmds `0x06/0x07/0x08` — all
respond RESP_OK defensively if received with the response flag, ignore otherwise.

**Conclusion: one firmware build covers iOS + Android (BT4.0/BLE path) + macOS** (the
iOS API's CoreBluetooth code runs on macOS unchanged). The only non-covered surface is
the legacy BT2.0 classic-SPP path, which the nRF52840 can't speak and no one needs.

## 9c. Web app — JavaScript client of the same protocol

Decision: **v6 speaks the InputStick protocol only. No dual-mode, no legacy raw protocol.**
The web app is rewritten as a JS client of that protocol. One protocol, three client
families: iOS/Android native apps (free) + Chrome web app.

**Survives unchanged (client-side):** MacroPanel + Import/Export + localStorage,
dictation (Web Speech API / Gboard), compose-mode UI.

**Rewritten (BLE layer — `ble.ts` / `macroSync.ts`):**
- Handshake: connect → subscribe TX → `RunFirmware` → `GetFirmwareInfo` → `SetUpdateInterval`
  → wait for `HIDStatusNotification` ready.
- Send: build InputStick packets (CRC32 + 16-byte framing) → write to NUS RX
  (write-without-response).
- Text→HID: char → (modifier, keycode) via existing layout tables → `HIDDataKeyboardShort`
  (0x2C) packets.
- Receive: parse TX notifications (status + drain counts) for flow control.

**Web Bluetooth note:** plaintext NUS writes (no pairing) are *simpler* than v5.x's
forced-encryption path — the web app stops fighting Chrome's bonding.

## 10. Open questions (close before/while testing)

1. **Firmware-info full field map** — the client only reads version/flags/password at
   fixed offsets. The real firmware-info packet likely carries name, capabilities, etc.
   For emulation, 19 zero-padded bytes with the 4 known fields set *should* satisfy the
   client, but confirm against the actual app (or capture a real InputStick over BLE).
2. **HIDStatusNotification full field map** — we know data[0,1,3,5,6,7,8,9]. data[2,4,10..]
   unknown. Zero-fill and confirm the app stays happy.
3. **respCode values** — `0x01` = success is assumed (matches the notify path + auth path).
   Confirm RunFirmware/GetFirmwareInfo responses are accepted with 0x01.
4. **Touchscreen x/y range** — InputStick 16-bit vs our 15-bit. Decide scale vs descriptor
   change.
5. **Device name in the app list** — name `InputStick` so it shows cleanly; app filters by
   service UUID, not name, so connection doesn't depend on it.
6. **InputStickProtocol official doc?** Check `inputstick/InputStickAPI-Android` and any
   protocol.md in the org — may resolve #1/#2 definitively without a live capture.

## 11. Validation plan

1. Flash v5.15 → confirm it advertises as `InputStick` (nRF Connect / LightBlue on iPhone).
2. Install the free **InputStick** iOS app → scan → should list our dongle.
3. Connect → app should reach "Ready" (watch our debug LED for RX/notify activity).
4. Type text in the app's keyboard → text appears on the PC.
5. Dictate (app's real-time dictation) → speech → text typed on PC. **This is the goal.**
6. Mousepad + touchscreen → cursor moves (bonus).
7. Stress: paste a long paragraph → confirm no freeze (validates §6.1 flow control).

## 12. Milestones / mission breakdown

- **M1 (protocol doc):** this spec. ✅ done.
- **M2 (firmware v6.0):** strip encryption/bonding + add `inputstick.c` packet layer +
  handshake responses + keyboard-short→USB mapping. Deliver uf2.
- **M3 (flow control):** HID report buffer + drain counter + 400 ms HIDStatusNotification.
- **M4 (test against app):** connect + type + dictate on real iPhone and Android.
- **M5 (web app rewrite):** port `ble.ts`/`macroSync.ts` to the InputStick protocol.
- **M6 (optional):** mouse/touchscreen/consumer polish; close the remaining open questions.

---

*Sources: `InputStickAPI-iOS` (github.com/inputstick), files: InputStickConnectionManager.m,
InputStickPacket.{h,m}, InputStickTxPacket.m, InputStickRxPacket.{m,+FirmwareInfo.m},
NSData+CRC.m, InputStickPacketParser.m, InputStickHIDFirmwareManager.m, InputStickHIDReport.m,
InputStickHIDTransactionBuffer.m, InputStickHIDBuffersState.m, InputStickKeyboardLEDsState.m,
InputStickManager.h, InputStickConst.m.*
