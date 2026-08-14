# USB Remote (1.93) + official protocol PDFs — what they add/correct vs our emulation spec

Analysis of the decompiled `USB Remote.apk` and the 8 official InputStick protocol
PDFs, cross-checked against the prior `APK_ANALYSIS.md` (InputStickUtility) and
`INPUTSTICK_EMULATION_SPEC.md`.

Path abbreviations used in citations:

- **UR** = `/tmp/usbremote_invest/decomp/sources/com/inputstick/` (USB Remote, app v1.93,
  bundles `com.inputstick.api`).
- **ISU** = `/tmp/inputstick_apk_decomp/sources/com/inputstick/` (InputStickUtility).
- **Docs** = `/tmp/usbremote_invest/pdftxt/<name>.txt` page N (the 8 PDFs; all are
  "Rev 4, 16.02.2016, based on v0.98 InputStick firmware").
- **FW** = `/home/claude/voice_keyboard/firmware/src/inputstick.c` (our firmware).

---

## TL;DR

1. **USB Remote does no Bluetooth itself.** Its manifest has no BT permission and its only
   services are `MacroService`/`PresentationTimerService`
   (`/tmp/usbremote_invest/decomp/resources/AndroidManifest.xml`).
   Every connect call is `InputStickHID.connect(getApplication())`, which builds an
   `IPCConnectionManager` that binds to **InputStickUtility's** `InputStickService`
   (`UR/api/IPCConnectionManager.java:121-149`). So the GATT UUIDs, handshake, MTU and
   version gates are **identical to InputStickUtility** (NUS `6e400001/2/3`, MTU 23,
   `RunFirmware→GetFirmwareInfo→SetUpdateInterval(0x31,param4)→0x2F`). USB Remote
   requires InputStickUtility to be installed (else error 4097 → download dialog).
2. **The HM-10 (`0000ffe0/ffe1`) and Dialog-DA (`0783b03e-…`) UUIDs in USB Remote's bundled
   `BT40Connection` are dead code** — an older `com.inputstick.api` snapshot. It also carries
   the older `BasicInitManager` handshake that sends **`CMD_INIT (0x11)`** and
   `SetUpdateInterval(0x31, param 5)` *with* response flag — a path USB Remote never runs.
   Useful as evidence of the older protocol, not as a new requirement.
3. **HID report layouts are fully confirmed, all standard USB HID** (no custom map):
   keyboard `0x21` = 8 B `[mods,0x00,key0..5]`; **text typing = `0x2C`** 2 B `[mods,key]`;
   mouse `0x23` = 4 B `[buttons,dx,dy,scroll]`; consumer `0x22` = 3 B `[reportID=1,usageLSB,usageMSB]`;
   system = reportID 2; touchscreen `0x26` = 6 B; gamepad `0x24` = 7 B. Keycodes are the
   standard USB HID Usage-table map (`0x04`='a', …).
4. **The 0x2F status layout is confirmed and two spec errors are now pinned down:** the `0xFF`
   "sent-to-host" gate is at **offset +10** (our spec said +11), and there are **two raw-HID
   fields at +11/+12** that USB Remote reads (`UR/api/HIDInfo.java:64-77`). Protocol-byte
   semantics are **1 = report protocol, 0 = boot** — the PDFs say the opposite (stale).
5. **The PDFs are clearly for the OLD 0.x firmware** (v0.98, 2016): only HM-10 UUIDs (no NUS),
   fixed 100 ms status interval (no `0x31`), `0x11` = "Reset report buffers" (not CMD_INIT),
   32-report buffers, no HMAC flag bit, version "0.95" scheme. The **packet framing
   (0x55 tag, CRC32 big-endian, 16-byte blocks) is unchanged and still accurate**.
6. **Concrete firmware fixes (ranked):** (a) shrink/fragment notifications to ≤20 B — the
   18-byte status packet and the 34-byte GetFirmwareInfo reply are the real blockers; (b) move
   `0xFF` to `st[10]` and send periodic 400 ms status with drain counts; (c) report version
   **101**; (d) reply to Identify with `0x42`; (e) add a consumer(0x22) handler if media keys
   are wanted.

---

## §1 USB Remote app analysis

### 1.1 It is a pure client of InputStickUtility's service

- USB Remote declares only `WRITE_EXTERNAL_STORAGE` + `VIBRATE`; **no Bluetooth permission**
  (`/tmp/usbremote_invest/decomp/resources/AndroidManifest.xml`). The two `<service>` entries are
  `MacroService` and `PresentationTimerService`.
- All connect calls in the app are `InputStickHID.connect(getApplication())`
  (`UR/apps/usbremote/MainActivity.java:143`, `ConfigurationActivity.java:186`,
  `QuickShortcutsSupport.java:376`, `TypeExternalActivity.java:65`).
- `InputStickHID.connect(Application)` builds `new IPCConnectionManager(app)`
  (`UR/api/basic/InputStickHID.java:66-69`). `IPCConnectionManager.connect()` binds to
  **`com.inputstick.apps.inputstickutility` / `…service.InputStickService`**
  (`UR/api/IPCConnectionManager.java:121-149`), and relays raw packet bytes + state over a
  Messenger. If that package is absent → error `4097` (`:122-147`), which triggers the
  "install InputStickUtility" dialog (`InputStickHID.getDownloadDialog`,
  `UR/api/basic/InputStickHID.java:59-64`).

**Conclusion for Q1:** USB Remote uses **the same GATT service/char UUIDs and the same
handshake as InputStickUtility**, because it literally reuses InputStickUtility's BLE service.
Nothing new is required at the GATT level beyond what `APK_ANALYSIS.md` already established.

### 1.2 GATT UUIDs — the bundled library is an *older* snapshot (dead code)

`UR/api/bluetooth/BT40Connection.java` only recognizes two BLE services:

| hardwareType (local) | service UUID | RX / TX chars | mode |
|---|---|---|---|
| `HW_HM` = 1 | `0000ffe0-0000-1000-8000-00805f9b34fb` (HM-10) | single `0000ffe1-…` for both RX+TX (`:25-30,46-47,88-93`) | notify (CCC `0x2902`) + write-no-response |
| `HW_DA` = 2 | `0783b03e-8535-b5a0-7140-a304d2495cb7` (Dialog SPS) | RX `…5cba`, TX `…5cb8` (`:48-51,99-107`) | indication (desc `0x2901`) |

There is **no `6e400001` NUS branch** in this class. The NUS service is only handled inside
InputStickUtility's service (the one that actually runs). So our nRF52840 NUS peripheral is
correct as-is; the HM-10/DA UUIDs only matter if someone embeds this old `com.inputstick.api`
directly (not what USB Remote does).

This also matches the docs: `bluetooth.pdf` p.1 lists "Hardware 0x01 = BT2.1 SPP `00001101`"
and "Hardware 0x02 = BT4.0 `0000ffe0`/`0000ffe1`" — **the PDFs never mention NUS**; NUS is a
later hardware revision.

### 1.3 MTU — still 23, still no negotiation

`grep requestMtu` over the entire decompiled tree returns **zero matches**. USB Remote's own
`BT40Connection.write()` chunks outgoing data into 16-byte (and 18-byte header+first-block)
GATT writes with `setWriteType(1)` (`UR/api/bluetooth/BT40Connection.java:255-303,333`), and
its `PacketReader` reassembles incoming bytes one at a time
(`UR/api/bluetooth/PacketReader.java:26-76`). So the effective ATT MTU is the Android default
**23** (= 20-byte notification payload), and **our notifications must still be ≤20 bytes per
`bt_gatt_notify`**. Same conclusion as `APK_ANALYSIS.md` §7.

### 1.4 Handshake — two variants, only one is live

**(a) The live path (IPC → InputStickUtility's `HIDFirmwareManager`):**
`RunFirmware(0x04)` → `GetFirmwareInfo(0x10)` → `SetUpdateInterval(0x31, param 4)` (no
response flag) → wait for `0x2F` with USB state 5. **No `0x11`, no auth.** This is exactly
what `APK_ANALYSIS.md` §3b documented; USB Remote inherits it unchanged.

**(b) The bundled-but-dead `BasicInitManager`** (`UR/api/init/BasicInitManager.java`):
```
onConnected()           → send Packet(true, 0x04)            // RunFirmware, +retry@1s, timeout@2s (:20-42)
onData cmd==0x04        → send Packet(true, 0x10)            // GetFirmwareInfo (:55-57)
onData cmd==0x10        → onFWInfo(...) → Packet(true, 0x11) // CMD_INIT!  (:58-60, InitManager.java:68)
onData cmd==0x11 rsp==1 → if version>=100: send Packet(true, 0x31, 5)  // SetUpdateInterval param=5 WITH response (:61-68)
                          else setStatusUpdateInterval(100)
onData cmd==0x2F        → param==5 → onInitReady()            (:77-90)
onData cmd==0x31 rsp==1 → setStatusUpdateInterval(500)        (:91-95)
```
This confirms two **older-protocol facts**:
- `CMD_INIT (0x11)` was a *real* init command in the older API (the PDFs' "Reset report
  buffers (0x11)", `commands.pdf` p.5). InputStickUtility's newer app dropped it.
- The older API used `SetUpdateInterval` param **5** (500 ms) **with** the response flag and
  expected a response; InputStickUtility uses param **4** (400 ms) **without** response. Our
  firmware already replies to `0x31` only when the response flag is set
  (`FW:360-366`), so it covers both.

**Handshake fix implication:** nothing new to *require*; we already answer `0x11` with
RESP_OK (`FW:357-359`), which is the safe superset.

### 1.5 Firmware version gates in USB Remote

`UR/api/init/DeviceInfo.java` parses the firmware-info payload and computes
`version = major*100 + minor` (`:63-65`). Gates actually exercised by USB Remote:

| gate | where | effect |
|---|---|---|
| `version >= 100` | `InputStickHID.java:392-396` | bump local HID queues **128 / 64 / 64** (else 32/32/32) |
| `version >= 100` | `BasicInitManager.java:64-66` | send `0x31 param 5` instead of `setStatusUpdateInterval(100)` (dead path) |
| `>=91/97/98` | `DeviceInfo.java:67-81` | `supportsEncryption/PinChange/Gamepad/RestoreOptions` — **UI menus only** |
| `version < 96` → "unlocked" | `DeviceInfo.java:39-41` | security-state shortcut (no password ⇒ irrelevant) |

There is **no hard refusal and no minimum/maximum version check** in USB Remote (it has no
"latest firmware" nag — that lives in InputStickUtility). Reporting **101** (see §4) keeps
both apps happy and activates the 128/64/64 accounting.

---

## §2 Mouse / keyboard / consumer HID report byte layouts + keycode map

### 2.1 Interface → command mapping (authoritative)

`UR/api/hid/HIDTransactionQueue.java:23-47` maps each interface queue to its command, and
`UR/api/Packet.java:5-58` defines the constants:

| interface (queue) | cmd const | hex | report size |
|---|---|---|---|
| keyboard (0) | `CMD_HID_DATA_KEYB` = 33 | **0x21** | 8 B |
| consumer (1) | `CMD_HID_DATA_CONSUMER` = 34 | **0x22** | 3 B |
| mouse (2) | `CMD_HID_DATA_MOUSE` = 35 | **0x23** | 4 B |
| raw HID (3) | `CMD_HID_DATA_RAW` = 39 | **0x27** | 64 B |
| (override) | `CMD_HID_DATA_TOUCHSCREEN` = 38 | **0x26** | 6 B |
| (override) | `CMD_HID_DATA_KEYB_FAST` = 44 | **0x2C** | 2 B (short) |
| (defined, unused) | `CMD_HID_DATA_KEYB_FASTEST` = 45 | 0x2D | 2 B (press+release) |
| (defined) | `CMD_HID_DATA_GAMEPAD` = 36 | 0x24 | 7 B |

The **param byte = number of reports in the packet**; the payload is `param × reportSize`
concatenated (`HIDTransactionQueue.sendFromQueue`, `UR/api/hid/HIDTransactionQueue.java:103-147`).
A transaction carrying a non-default command byte (e.g. `44`) overrides the interface's
command via `p.modifyByte(0, firstTransactionCmd)` (`:131-133`).

### 2.2 Keyboard

**Full report — `0x21`, 8 bytes** (`UR/api/hid/KeyboardReport.java:8-17`):
```
[0] modifiers bitmask
[1] reserved (always 0x00 — never written)
[2..7] key0..key5  (6KRO keycodes, 0 = none)
```
`InputStickKeyboard.pressAndRelease(mod,key)` sends **3 full reports**: `[mod,0]` →
`[mod,key]` → `[0,0]` (`UR/api/basic/InputStickKeyboard.java:44-50`). This is the path used by
the on-screen key buttons, modifier toggles, toggle keys and `typeASCII`
(`:80-101,125-135`).

**Short report — `0x2C`, 2 bytes** (`UR/api/hid/ShortKeyboardReport.java:8-12`):
```
[0] modifiers
[1] keycode (single key)
```
This is **the text-typing path**. `KeyboardLayout.getHIDTransaction` builds a
`HIDTransaction((byte)44)` of `ShortKeyboardReport`s (`UR/api/layout/KeyboardLayout.java:186-213`),
and `type()` flushes the keyboard queue (`:53-70`). At `typingSpeed==0` (FASTEST) each
character is **one** `[mod,key]` report, with a trailing empty `[0,0]` appended
(`:63-67,215-229`) — the dongle must treat each report as the *current keyboard state*
(expand to `[mod,0x00,key,0,0,0,0,0]`), and the next report releases the previous key.

**Press+release — `0x2D`, 2 bytes** — defined in `Packet.java:17` and `commands.pdf` p.23 but
**never emitted by USB Remote** (grep confirms only the constant; text uses `0x2C`).

### 2.3 Mouse — `0x23`, 4 bytes

`UR/api/hid/MouseReport.java:8-14`:
```
[0] buttons  bit0 = left (1), bit1 = right (2), bit2 = middle (4)
[1] dx  (signed)
[2] dy  (signed)
[3] scroll/wheel (signed)
```
`InputStickMouse` buttons are `BUTTON_LEFT=1, BUTTON_RIGHT=2, BUTTON_MIDDLE=4`
(`UR/api/basic/InputStickMouse.java:9-12`); `move(x,y)`, `scroll(wheel)`, `click(button,n)`,
`customReport(buttons,x,y,wheel)` all assemble the same 4-byte report (`:26-52`). The mouse-pad
UI sends `customReport(buttonByte, dx, dy, scroll)` with signed bytes scaled by sensitivity
(`UR/apps/usbremote/MouseSupport.java:347,403-428`). Our firmware already casts to `int8_t`
(`FW:285-286`).

### 2.4 Consumer / system — `0x22`, 3 bytes

`UR/api/hid/ConsumerReport.java:7-24`:
```
[0] report ID:  1 = consumer,  2 = system
[1] usage LSB
[2] usage MSB
```
`InputStickConsumer.consumerAction(usage)` sends `[1, usageLSB, usageMSB]` then a zero report
(`UR/api/basic/InputStickConsumer.java:49-53`); `systemAction(action)` sends `[2, action, 0]`
then `[2,0,0]` (`:30-35`). Usages (standard HID Consumer Page, all ≤0x02FF so LSB carries the
code):

| action | value (hex) |
|---|---|
| Play/Pause | 205 (0xCD) |
| Track next / prev | 181 (0xB5) / 182 (0xB6) |
| Stop | 183 (0xB7) |
| Vol mute / up / down | 226 (0xE2) / 233 (0xE9) / 234 (0xEA) |
| Launch email / calc / browser | 394 / 402 / 406 |
| Search / Home / Back / Forward / Refresh | 545 / 547 / 548 / 549 / 551 |
| System power-down / sleep / wake | 1 / 2 / 3 (report ID 2) |

(`UR/api/basic/InputStickConsumer.java:8-25`; `MediaActivity` wires VOL/MUTE/play/power,
`UR/apps/usbremote/MediaActivity.java:53-148,230-231`.) **Our firmware currently drops these**
(no `0x22` handler — see §4.5).

### 2.5 Touchscreen — `0x26`, 6 bytes; Gamepad — `0x24`, 7 bytes; Raw — `0x27`, 64 bytes

```
TouchScreen (UR/api/hid/TouchScreenReport.java:8-24):
  [0] = 4 (report ID)
  [1] = tipSwitch(bit0) | inRange(bit1)
  [2..3] x LSB,MSB  (16-bit)
  [4..5] y LSB,MSB
  → sent with transaction cmd 38 (0x26) through the CONSUMER queue
    (UR/api/basic/InputStickTouchScreen.java:13-48)

Gamepad (UR/api/hid/GamepadReport.java:9-18):
  [0] = 3 (report ID), [1] buttons1-8, [2] buttons9-16, [3..6] x,y,z,rx

Raw HID (UR/api/hid/RawHIDReport.java:5-20): 64-byte payload via 0x27.
```

### 2.6 Keycode map — **standard USB HID, no custom table**

`UR/api/hid/HIDKeycodes.java` is the full standard HID Usage-table (Boot Keyboard) map:
`KEY_A=4 … KEY_Z=29`, `KEY_0=39`, `KEY_ENTER=40`, `KEY_ESCAPE=41`, `KEY_BACKSPACE=42`,
`KEY_SPACEBAR=44`, `KEY_CAPS_LOCK=57`, `KEY_F1=58…F12=69`, arrows 79-82, numpad 83-99, etc.
(`:14-110`). Modifiers are the standard bitmask (`:7-13,117-125`):
`LCtrl=1, LShift=2, LAlt=4, LGui=8, RCtrl=16, RShift=32, RAlt=64, RGui=128(0x80)`.

`ASCIItoHID[]` (`:224`) maps ASCII → keycode with **bit 0x80 set to indicate Shift** (e.g.
`'!'=158=0x80|30`), and `typeASCII` strips it back out (`InputStickKeyboard.java:92-97`).
`KeyboardLayout.scanCodeToHID` (`UR/api/layout/KeyboardLayout.java:16`) maps Android
scancodes to the same standard HID codes. The PDFs agree (`hid.pdf` p.1-3, key "A"=0x04,
"Y"=0x1C, "3"=0x20, Space=0x2C, Delete=0x4C, Esc=0x29 …). **Conclusion: plain standard USB
HID keycodes; nothing custom.** Our `tap()`/`hid_kbd()` already treat them as standard.

---

## §3 Protocol docs: what's stale vs accurate

The docs are all "Rev 4, 16.02.2016, based on v0.98". They describe the **0.x** firmware line;
the current apps target the **1.x** line (101/112). Table of claims:

| # | Topic | PDF claim (page) | Current apps (decompiled) | Verdict |
|---|---|---|---|---|
| 1 | Framing: `0x55` tag, INFO_BYTE, 16-B payload parts, CRC32 big-endian over CMD..padding, notification has no RESP_CODE | `packet.pdf` p.1-4 | `PacketManager.java:118-171` (build) / `:86-102` (parse); `Packet.java:44-53` flags | **Accurate** (unchanged) |
| 2 | INFO_BYTE bits: 7=RESP, 6=ENCR, **5=reserved**, 4..0=part count | `packet.pdf` p.2 | bit 5 is now **HMAC** = `FLAG_HMAC=0x20` (`Packet.java:45`, `PacketManager.java:161`) | **Stale** — bit 5 repurposed (only matters when password set) |
| 3 | Max 17 parts × 16 B = 272 | `packet.pdf` p.1-3 | `MAX_SUBPACKETS=17, MAX_TOTAL_LENGTH=272` (`Packet.java:48-49`) | Accurate |
| 4 | BT4.0 UUIDs = HM-10 `0000ffe0`/`0000ffe1` | `bluetooth.pdf` p.1 | Apps use **NUS `6e400001/2/3`** (`APK_ANALYSIS.md` §2) | **Stale** — NUS is a newer HW rev, undocumented |
| 5 | Handshake: `0x04` → `0x10` → [auth] → wait `0x2F` | `examples.pdf` p.1-4 | Same core, **plus** `SetUpdateInterval(0x31)` (ISU param 4 no-response; older lib param 5 with-response) | Partially stale — `0x31` missing from docs |
| 6 | `0x11` = "Reset report buffers" (FW ≥0.94) | `commands.pdf` p.1,5 | Android old API = **CMD_INIT (sent + RESP_OK)**; iOS/new app = **WdgReset notification**; `Packet.java:25` | **Stale/repurposed** — semantics changed |
| 7 | Status update every **100 ms**, fixed | `commands.pdf` p.25; `USB.pdf` p.2 | App sets interval via `0x31` = 400 ms (ISU) / 500 ms (old lib) | **Stale** — interval now programmable |
| 8 | Buffers = **32** reports each | `USB.pdf` p.2 | v≥100 ⇒ **128/64/64** (`InputStickHID.java:392-396`) | **Stale** — capacity grew |
| 9 | `0x2F` layout: `[0]state [1]LEDs [2]kbdProto [3]kbdEmpty [4]mouseProto [5]mouseEmpty [6]consumerEmpty [7..9]sent [10]reserved(0xFF)` | `commands.pdf` p.25 | Identical offsets (ISU `InputStickStatusUpdate.java:18-31`; UR `HIDInfo.java:21-80`), **plus** raw-HID fields at `[11]empty [12]sent` (UR only) | Mostly accurate; **raw-HID fields added** after v0.98 |
| 10 | Protocol byte: **0x00 = report protocol, 0x01 = BOOT** | `commands.pdf` p.25 | Apps read **1 = report, 0 = boot** (`InputStickStatusUpdate.java:23-24` `data[2]==0 ⇒ boot`; `HIDInfo.java:39-43` `data[3]==1 ⇒ report`) | **Stale/inverted** — apps and docs disagree; trust the apps |
| 11 | Firmware-info layout `[0]'B' [1]major [2]minor [3]hwrev … [17]authenticated [18]password` | `commands.pdf` p.3; example `0x42 0x00 0x5F …` = v0.95 | Same offsets for type/major/minor/hwrev/security(17)/password(18); version now `major*100+minor` (`DeviceInfo.java:63-65`; `APK_ANALYSIS.md` §5) | Accurate offsets; **version scheme changed** (0.x → 1xx) |
| 12 | HID report formats (keyboard/short/mouse/consumer/system/gamepad) | `hid.pdf` p.1-10; `commands.pdf` p.15-23 | Byte-for-byte identical in `UR/api/hid/*` | **Accurate** |
| 13 | "≤8 packets / 100 ms, ignore incoming data" | `quickstart.pdf` p.1 | Superseded by 0x2F flow-control accounting | **Stale** advice |
| 14 | AES-128 password + challenge (`0x12`) | `security.pdf`, `commands.pdf` p.6-7 | Same command, + HMAC variant `0x30` at v≥100 (`PacketManager.encPacket`) | Accurate (we report no password ⇒ never exercised) |

The one framing subtlety worth stating: the docs reserve bit 5 of INFO_BYTE; the current
libraries use it as `FLAG_HMAC` and the receive-side length mask is `info & 0x3F`
(`PacketReader.java:49`), so a plain (non-encrypted, non-HMAC) packet — which is all we ever
emit — is unaffected.

---

## §4 Concrete firmware changes this implies (ranked)

### 1. **[CRITICAL] Don't emit >20-byte notifications (fragment or shrink)**

`ble_notify()` sends the whole InputStick packet in one `bt_gatt_notify` (`FW/ble.c:185-228`);
Zephyr's ATT MTU is 23, so anything >20 B is dropped. Two of our packets currently exceed it:

- `GetFirmwareInfo` reply: 19 data bytes → payload `6+19=25` → 2 blocks → **34 B**
  (`FW:182-196`, `build_packet` at `:126-137`).
- `HIDStatusNotification`: 12 data bytes → payload `5+12=17` → 2 blocks → **34 B**
  (`FW:198-215`).

**Fix (two complementary options):**
- Shrink the status packet to **11 data bytes** (fix #2) → payload `5+11=16` → 1 block →
  **18 B**, which fits in a single notify.
- For the unavoidable 34-B GetFirmwareInfo reply, **chunk `ble_notify` into ≤20-B
  `bt_gatt_notify` calls** (the peer's `PacketReader` reassembles a byte stream across
  notifications — `UR/api/bluetooth/PacketReader.java:26-76`; this is also how iOS works).

### 2. **[CRITICAL] Correct the 0x2F status byte layout + add periodic drain counts**

Current `send_hid_status()` writes `st[11]=0xFF` and nothing at `st[10]` (`FW:198-215`).
Authoritative layout (bytes after the `0x2F` command), reconciled from both apps + docs:

```
[0]  USB state        = 0x05 (USBConfigured)
[1]  keyboard LEDs    = 0x00 (bit0 NumLock, bit1 CapsLock, bit2 ScrollLock)
[2]  keyboard protocol = 0x01  (1 = report protocol; 0 = boot)
[3]  keyboard buffer empty = 0x01
[4]  mouse protocol   = 0x01
[5]  mouse buffer empty = 0x01
[6]  consumer buffer empty = 0x01
[7]  keyboard reports sent to host (since last notify)
[8]  mouse reports sent to host
[9]  consumer reports sent to host
[10] 0xFF  ← the sent-to-host gate (USB Remote HIDInfo only reads [7..9] when this == 0xFF)
[11] raw HID buffer empty   (optional; only if you also report raw HID)
[12] raw HID reports sent   (optional)
```
- **Move `0xFF` from `st[11]` to `st[10]`.** USB Remote requires `data.length >= 12 && data[11]==0xFF`
  (`UR/api/HIDInfo.java:64-69`) = offset +10; InputStickUtility ignores offsets ≥10
  (`ISU/…/InputStickStatusUpdate.java:28-30`), so +10 satisfies both.
- **Keep `st[2]=0x01` / `st[4]=0x01`** (report protocol). The PDFs' "0x00 = report" is inverted
  relative to both apps (see §3 #10).
- **Send it periodically** at the `SetUpdateInterval` rate (400 ms), not once. Store the
  interval param from `0x31` (`FW:360-366` currently ignores it) and start a timer. This is
  the flow-control contract: the app's `freeSpace` is only replenished by the `[7..9]` drain
  counts (`UR/api/hid/HIDTransactionQueue.java:60-101`).
- **Report real drain counts.** Our firmware types synchronously (no buffer), so increment a
  per-interface "reports consumed" counter in `hid_kbd`/`hid_kbd_short`/`hid_mouse`/`hid_touch`
  and emit those counts (reset after each status). Buffer-empty flags stay `0x01`.
- Skip the raw-HID fields (`[11]/[12]`) unless you implement `0x27` — if omitted, USB Remote
  defaults `rawHIDReady=true` (`HIDInfo.java:70-80`) and the 11-byte packet stays ≤20 B.

### 3. **[Required] Report firmware version 101**

`respond_fw_info()` sets `info[2]=0` → version 100 (`FW:189`). Change to `info[2]=1` → **101**
(major=1, minor=1). This clears InputStickUtility's auto-update nag and enables its
128/64/64 + `SetUpdateInterval` path (see `APK_ANALYSIS.md` §1). USB Remote itself only needs
≥100, so 101 covers both. Optionally set `info[0]=0x42` ('B') for fidelity — the docs'
firmware-info example shows `0x42` as the firmware-type byte (`commands.pdf` p.3,
`examples.pdf`), though both apps ignore that byte.

### 4. **[Required] Identify reply must carry `0x42`**

`FW:389-396` replies to `0x01` with **no data**. InputStickUtility's management screen requires
`data[0]==0x42 ('B')` to proceed (`APK_ANALYSIS.md` §3c). Reply with one data byte `0x42`.

### 5. **[Optional] Handle `0x22` consumer/system reports (media keys)**

`MediaActivity` sends consumer (`reportID 1`) and system (`reportID 2`) reports over `0x22`
(§2.4), which our firmware currently drops (no `0x22` case → default RESP_OK). To make USB
Remote's media keys work, add `IS_CMD_HID_CONSUMER` mapping each 3-byte report
`[reportID, lsb, msb]` to a USB consumer-control HID report (we don't yet have a consumer
interface in the USB composite; adding one is a larger task). Ranked last because keyboard +
mouse + dictation are unaffected.

### 6. **[Keep as-is / already correct]**

- NUS `6e400001/2/3` GATT + CCC + write-without-response (`FW/ble.c:77-89`) — correct; USB
  Remote inherits it via IPC.
- `0x2C` short-keyboard `tap()` (press+release) and `0x21` full-keyboard forwarding
  (`FW:240-274`) — correct for both apps' typing/button paths.
- Mouse 4-byte report with `int8_t` dx/dy/scroll (`FW:277-288`) — correct.
- `0x11` → RESP_OK (`FW:357-359`) — correct superset (harmless to InputStickUtility, required
  by the older BasicInitManager if it is ever used).
- `0x31` reply only when the response flag is set (`FW:360-366`) — correct for both ISU (no
  flag) and the older lib (flag set).
- Touchscreen `0x26` 6-byte parse with `x>>1,y>>1` scaling (`FW:293-307`) — correct (app sends
  0..10000 coords, well within 16-bit).

---

*Sources: decompiled `USB Remote.apk` v1.93 (`/tmp/usbremote_invest/decomp/sources/`),
`InputStickUtility` decompile (`/tmp/inputstick_apk_decomp/sources/`), the 8 official PDFs
(`/tmp/usbremote_invest/pdftxt/*.txt`), and `firmware/src/inputstick.c` + `ble.c`.*
