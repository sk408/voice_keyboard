# InputStickUtility APK — what the app actually demands from firmware

Analysis of the decompiled `com.inputstick` sources under
`/tmp/inputstick_apk_decomp/sources/`. All `file:line` citations refer to that tree
unless prefixed with the firmware tree path. The single most important result is at the
top so it isn't missed.

---

## TL;DR — the headline finding

**Our v6.0 firmware sends 34-byte GATT notifications over an ATT MTU of 23, so the
`GetFirmwareInfo` response and the `HIDStatusNotification` are silently dropped by the
Zephyr host and the handshake never completes.**

The app never calls `BluetoothGatt.requestMtu()` (the whole decompiled tree contains no
`requestMtu`/`MTU`/`exchange_mtu` call), so Android keeps the default ATT MTU of **23**
(= 20-byte notification payload). Zephyr initializes the UATT bearer to
`BT_ATT_DEFAULT_LE_MTU = 23` and refuses (drops) any ATT PDU whose `len + 1 > MTU`:

- `subsys/bluetooth/host/att.c:3448-3453` — `chan->chan.tx.mtu = chan->chan.rx.mtu = BT_ATT_DEFAULT_LE_MTU` (23) for UATT, "the initial MTU is defined by spec".
- `subsys/bluetooth/host/att.c:720-724` — `bt_att_chan_create_pdu()` returns `NULL` (packet dropped, **no fragmentation**) when `len + sizeof(op) > bt_att_mtu(chan)`.
- `att_internal.h:28` — `BT_LOCAL_ATT_MTU_UATT = MIN(BT_L2CAP_RX_MTU, BT_L2CAP_TX_MTU)`; our `prj.conf:31-32` raise this to 200, but that value is only used *after* an ATT MTU exchange that never happens.

Packet sizes our firmware actually emits (from `firmware/src/inputstick.c`):

| Packet | size | fits 20-byte notify? |
|---|---|---|
| `RunFirmware` reply (0x04) | 18 B (`2 + 16`) | ✅ |
| `Identify` reply (0x01) | 18 B | ✅ |
| **`GetFirmwareInfo` reply (0x10)** | **34 B (`2 + 32`)** | ❌ dropped |
| **`HIDStatusNotification` (0x2F)** | **34 B (`2 + 32`)** | ❌ dropped |

Consequence: GATT connect + CCC subscribe succeed, the app sends `RunFirmware` and gets
its 18-byte reply, then sends `GetFirmwareInfo` and receives nothing → 2×3 s init timeout
→ `ERROR_FW_INIT_TIMEDOUT` ("Firmware init timed out/not InputStick device",
`InputStickError.java:96`). This is the deterministic "won't connect" for the typing path.

---

## 1. Firmware version — report **101**

### Constants (`apps/inputstickutility/utils/UtilConst.java`)
- `UTILITY_LATEST_FIRMWARE_VERSION_NRF = 112` (`:75`)
- `UTILITY_LATEST_FIRMWARE_VERSION_STM = 110` (`:76`)
- `UTILITY_MIN_RECOMMENDED_FIRMWARE_VERSION = 100` (`:78`)
- `getLatestFirmwareVersion(d)`: returns **112 if hardwareType==4, else 110** (`:95-97`)
- `api/Const.java:8` — `LATEST_FIRMWARE_VERSION = 101` (the API-level "latest" the bundled
  `com.inputstick.api` library exposes to third-party apps).

### Where the version is actually read
`FirmwareInfo.java:20` — `version = data[1]*100 + data[2]` (major/minor in the firmware-info
payload, see §5). `InputStickManagerPrivateAccess.processPacket` stores it in
`mFirmwareVersion` (`InputStickManager.java:464-469`).

### Every version gate in the app
| Gate | File:line | Effect |
|---|---|---|
| `firmwareVersion >= 100` → send `SetUpdateInterval` | `HIDFirmwareManager.java:223` | below 100 the app skips SetUpdateInterval |
| `firmwareVersion >= 113 && rebootOnDisconnect` → append `0x05` to SetUpdateInterval | `HIDFirmwareManager.java:226-228` | only at ≥113 |
| `< 100` → 32/32 HID buffers; `>= 100` → 128/64 | `HIDBuffersManager.java:23-34` | buffer capacity |
| `supportsHMAC()` `>= 100` | `InputStickDeviceData.java:205-207` | only used if a password is set (we report none) |
| `supportsKeygen()` `>= 101` | `InputStickDeviceData.java:209-211` | TOTP menu availability |
| `supportsBTConfig()` `>= 99` | `InputStickDeviceData.java:213-215` | rename/PIN menu |
| `supportsUSBConfig()` false for 111/112/<99 | `InputStickDeviceData.java:217-220` | USB config menu |
| **update nag**: `shouldDisplayFirmwareUpdateMessage()` returns false iff `>= 101` | `InputStickDeviceData.java:179-194` | see below |
| **management nag**: update button shown iff `< 100` | `FirmwareFragment.java:117-124`, `InfoFragment.java:145-152`, `DeviceManagementActivity.java:197-202` | |

### Is there a hard refusal gate? **No.**
`ERROR_FW_UNSUPPORTED_VERSION = 771` (`InputStickError.java:41,98`) exists as a constant and
string but is **never thrown anywhere** (grep confirms the only occurrences are the definition
and the error map). The app never refuses to talk to a device based on version.

### The two "nags" and how to avoid both
1. **Management UI** shows an "update recommended" button when `version < 100`
   (`FirmwareFragment.java:118`).
2. **After reaching Ready** in the HID flow, `HIDFirmwareManager.processPacket` calls
   `shouldDisplayFirmwareUpdateMessage()` (`HIDFirmwareManager.java:194-197`), which returns
   `true` when `version < 101` (`InputStickDeviceData.java:180`). In the typing service the
   listener is `InputStickService.showFirmwareUpdateDialog` which is an **empty no-op**
   (`InputStickService.java:112-114`), so it is suppressed there — but it is not suppressed
   everywhere the HID manager runs.

**Recommendation: report firmware version `101`** (firmware-info `data[1]=1, data[2]=1`).
This is the lowest value that satisfies *both* `>= 100` (no management nag, SetUpdateInterval
sent, 128/64 buffers) **and** `>= 101` (no auto-update prompt). It additionally flips
`supportsKeygen()` true, but keygen is purely user-initiated and our firmware can answer
those commands defensively; it has no effect on connect/ready/typing.

Version `100` (what we currently report) is *almost* fine — it clears the management nag —
but still triggers `shouldDisplayFirmwareUpdateMessage()`.

Hardware-type interaction: the "latest" version the UI quotes is 112 vs 110 based on
detected type, but that is **display only** — it does not gate anything (§6).

---

## 2. GATT / advertising — exact requirements

### Scanner filter (`api/connection/DeviceScanner.java:101-115`)
The BLE scan uses **two `ScanFilter`s by service UUID only**:
- `0000ffe0-0000-1000-8000-00805f9b34fb` (HM-10 SPS), and
- `6e400001-b5a3-f393-e0a9-e50e24dcca9e` (Nordic NUS).

There is **no name filter and no manufacturer-data filter** anywhere in the scanner or the
scan-list UI. The name is used only to highlight the row: `ScanListAdapter.java:76-78`
colorizes the entry when `name.equalsIgnoreCase("InputStick")`. So:

- **Required to appear in the list:** advertise the 128-bit service UUID
  `6e400001-b5a3-f393-e0a9-e50e24dcca9e` in the advertising data.
- **Not required:** the name `InputStick` (cosmetic only), any manufacturer data, any flags.

**⚠️ Risk in our firmware:** `ble.c:101-105` puts the UUID in the **scan response** (`sd[]`),
not the primary ADV (`ad[]` carries flags + name). Android's `ScanFilter.setServiceUuid`
can be offloaded to the BLE controller on some phones, which may match only the primary ADV.
Recommend moving the 128-bit NUS UUID into the **primary advertising payload** (and, if it no
longer fits, drop/shorten the name or move the name to the scan response).

### GATT layout required at connect (`api/connection/bluetooth/BT40Connection.java`)
UUIDs (`:22-28`):
- Service: `6e400001-b5a3-f393-e0a9-e50e24dcca9e` (`UUID_NRF_SPS`)
- **App "RX" (subscribe/notify) = `6e400003-…`** (`UUID_NRF_RX`)
- **App "TX" (write) = `6e400002-…`** (`UUID_NRF_TX`)

`onServicesDiscovered` (`:67-118`) requires, for the NRF branch:
1. a GATT service whose UUID string equals `UUID_NRF_SPS` (`:85`),
2. `getCharacteristic(6e400003)` (rx) and `getCharacteristic(6e400002)` (tx) both non-null
   (`:86-88`), then sets `mBluetoothHardwareType = 4`,
3. `setCharacteristicNotification(rx, true)` + a `0x2902` CCC descriptor write succeed
   (`:100-111`) — only then `connectionEstablished()`.

Writes use `setWriteType(1)` = **write-without-response** to `6e400002` (`:274-276`), and
outgoing data is chunked to **20 bytes** (`getData()`, `:239-264`). Our `ble.c` RX char is
`WRITE | WRITE_WITHOUT_RESP` and TX is `NOTIFY` with a CCC — this all matches.

> Naming gotcha (matches our firmware, but worth stating): the app's "RX" is our notify
> char, its "TX" is our write char. `BT40Connection.UUID_NRF_RX = 6e400003`,
> `UUID_NRF_TX = 6e400002`.

### `isBluetoothLE` classification
`DeviceScanner.addBluetoothDevice` (`:156-160`) marks a device BLE iff
`BluetoothDevice.getType() == 2` (DEVICE_TYPE_LE); everything else is treated as classic and
the tap handler routes it to the BT2.0 PIN path (`DeviceDiscoveryActivity.java:359-363`).
A BLE peripheral normally reports type 2, so this is fine, but if the list ever shows our
device as "(BT2.0)" that means `getType() != 2` and the app will attempt classic RFCOMM,
which we cannot serve.

---

## 3. Handshake sequences (three different flows)

There are **three** `FirmwareManager` implementations; the app swaps them via
`setFirmwareManager()` (`InputStickManager.java:513-518`, which calls `startInitialization()`
immediately if already Ready).

### 3a. First-time connection / verification — `DeviceVerificationFirmwareManager.java`
Used when a **new (unsaved)** device is tapped in the scan list
(`DeviceDiscoveryActivity.connectAndVerify`, `:479-482`).

1. Send `Identify (0x01)`, param 0, **response flag set** (`:26-32`).
2. On **any** reply with `cmd == 0x01` → add device to DB, `setConnectionState(5)` = READY
   (`:41-47`). **Data content and respCode are ignored.**
3. 5 s timeout → `ERROR_FW_INIT_TIMEDOUT` (`:49-57`).

Our firmware already answers `Identify` with cmd 0x01 (`inputstick.c:389-396`), so this step
passes and the device gets saved.

### 3b. Typing service — `api/HIDFirmwareManager.java`
Set up by `InputStickService.doConnect` (`InputStickService.java:598-603`) and by default in
`InputStickManager` (`InputStickManager.java:161`).

1. **`RunFirmware (0x04)`**, param 0, response flag (`startInitialization`, `:46-53`).
   → expects a reply with `cmd == 0x04`; respCode is **not** checked (`:69-78`). It then
   sends `GetFirmwareInfo`.
2. **`GetFirmwareInfo (0x10)`**, param 0, response flag (`:74-77`).
   → expects `cmd == 0x10`; parses `FirmwareInfo` (`:86-91`). If `!isValid()` it is simply
   not used (the state machine hangs → timeout). If no password → `didAuthenticate()`.
3. **`SetUpdateInterval (0x31 = 49)`**, param `4` (400 ms), **response flag NOT set**,
   only if `version >= 100` (`didAuthenticate`, `:220-232`).
4. **`HIDStatusNotification (0x2F = 47)` with `data[0] == 5`** → `setConnectionState(5)` =
   READY (`:162-201`).

Notes on commands the app does **not** send: there is **no `CMD_INIT (0x11)`** in this APK —
`0x11` is only handled as a *device→app* `WdgReset` notification that aborts with
`ERROR_HW_WATCHDOG_RESET` (`:112-114`). `0x12` (authenticate) is only sent if the device
reports a password. `HIDRequestStatusReport (0x20)` is never sent proactively by this app;
the dongle must push status notifications on its own (§4).

`respCode` handling: for `RunFirmware`/`GetFirmwareInfo` the app does **not** check the
respCode; only the encryption/auth path (`0x30`/`0x12`) checks respCode (`:118-136`), and
notification commands synthesize respCode `1` (`RxPacket.java:84-89`). Our `IS_RESP_OK=0x01`
is correct.

### 3c. Device-management UI — `apps/.../UtilityFirmwareManager.java`
Set up by `ManagementAppCompatActivity.setupManagementActivity` (`:58-79`), which is the
screen the app auto-opens right after first-time verification.

1. `actionInit()` sends **`Identify (0x01)`**, param 0, response flag (`:655-665`).
2. `parseResponseForInitAction` expects a reply with `cmd == 0x01` and
   `data[0] == 0x42 ('B')` → sends `GetFirmwareInfo (0x10)`; `data[0] == 0x4C ('L')` →
   sends `GetBootloaderInfo (0x05)` (`:366-381`). Any other `data[0]` (including our
   all-zero reply) is ignored → 3 s action timeout → retry → `ACTION_ERROR_TIMEDOUT`
   (`actionTimeoutEvent`, `:644-653`).
3. On `GetFirmwareInfo` reply (`cmd 0x10`) → `setConnectionState(5)` + parse firmware info +
   (no password) `didAuthenticate()` → `SetUpdateInterval (0x31)` param 4, no response, iff
   `version >= 100` (`:382-402`, `:529-535`).

`'B'` = firmware running (`firmwareMode=true`, outer handler `:157-164`), `'L'` = bootloader
mode (`firmwareMode=false` → `AccessBootloader`, `getAccessLevel`, `:941-952`).

**Gap in our firmware:** `inputstick.c:389-396` replies to `Identify` with **no data**, so
`data[0] == 0x00`, which matches neither `'B'` nor `'L'` → the management screen never gets
past `Identify` and shows a timeout. Fix: reply `Identify` with one data byte `0x42`.

---

## 4. Status notification (0x2F) — exact byte layout

Parsed by `InputStickStatusUpdate.java:18-32` (offsets are `rxPacket.getData()`, i.e. the
bytes **after** the `0x2F` command byte; the app reads the notification with no param byte —
`RxPacket.java:42-44`):

| offset | field | app semantics |
|---|---|---|
| `data[0]` | USB state | `getUSBState()` (`:21,34`) — `5` = Ready |
| `data[1]` | keyboard LEDs | raw LED byte (`:22,38`) |
| `data[2]` | keyboard **boot** protocol | `== 0` ⇒ boot protocol (`:23,42`) — **not consumed anywhere** |
| `data[3]` | keyboard buffer empty | `!= 0` ⇒ empty (`:25,62`) |
| `data[4]` | mouse **boot** protocol | `== 0` (`:24,46`) — **not consumed anywhere** |
| `data[5]` | mouse buffer empty | `!= 0` (`:26,66`) |
| `data[6]` | consumer buffer empty | `!= 0` (`:27,70`) |
| `data[7]` | keyboard reports sent to host | drain count (`:28,50`) |
| `data[8]` | mouse reports sent to host | (`:29,54`) |
| `data[9]` | consumer reports sent to host | (`:30,58`) |
| `data[10..]` | — | **not read** |

USB state enum (`InputStickManager.java:88-93`): `0=USB_DISCONNECTED, 1=USB_ATTACHED,
2=USB_POWERED, 3=USB_SUSPENDED, 4=USB_ADDRESSED, 5=USB_CONFIGURED`.

**"Ready" = a 0x2F notification with `data[0] == 5`** while `initState` is 3 (HID flow,
`HIDFirmwareManager.java:184-199`) or on any `0x2F` with `data[0]==5` in the utility flow
(`UtilityFirmwareManager.java:167-172`).

**Two spec errors corrected:**
1. The `data[11] = 0xFF` "marker" is **not read** by this APK. `InputStickStatusUpdate`
   never touches `data[11]`. (The "0xFF gate" in `INPUTSTICK_EMULATION_SPEC.md` §7 is wrong
   for Android.)
2. `data[2]`/`data[4]` are **boot-protocol** flags (`==0` means boot protocol), and their
   getters (`isKeyboardBootProtocol()`/`isMouseBootProtocol()`) have **zero consumers** in the
   app — our `data[2]=0x01, data[4]=0x01` values are harmless.

### Flow control — periodic notifications are **required** for sustained typing
`InputStickManagerPrivateAccess.processPacket` feeds every 0x2F into
`HIDBuffersManager.updateState` (`InputStickManager.java:451-453`), which feeds
`HIDTransactionBuffer.updateState(reportsSentToHost, bufferEmpty)`:

- capacity/freeSpace for `version >= 100`: keyboard **128** (max 64/packet), mouse **64**
  (32/packet), consumer **64** (32/packet) (`HIDBuffersManager.java:23-34`).
- `freeSpace` starts at capacity; each report sent decrements it
  (`HIDTransactionBuffer.java:74-113`).
- `freeSpace += reportsSentToHost` (capped) on each status notification, or, after **5
  consecutive** "bufferEmpty && reportsSentToHost==0" notifications, freeSpace resets to
  capacity (`updateState`, `:44-72`).

The app sends `SetUpdateInterval(0x31, 4)` = 400 ms and **expects the dongle to push 0x2F
every ~400 ms** (and on buffer-drain changes). Our firmware emits exactly **one** 0x2F
(`ready_sent` guard in `inputstick.c:217-233`) and has no timer. Result: the app can type at
most ~128 keyboard reports (~43–64 characters of dictation, since each short-kbd char is 2–3
reports — `InputStickKeyboard.pressAndRelease`, `:155-174`) and then **stalls forever**.
This is the "won't work after a burst" bug.

---

## 5. Firmware-info (0x10) response — exact format

Parsed by `FirmwareInfo.java:13-27` from `rxPacket.getData()` (bytes after cmd+respCode,
`RxPacket.java:45-46`):

| offset | field | read at | our value |
|---|---|---|---|
| `data[0]` | firmwareType | (ignored by Android) | 1 |
| `data[1]` | versionMajor | `:20` (`*100`) | 1 |
| `data[2]` | versionMinor | `:20` | **0 → change to 1** |
| `data[3..16]` | reserved | — | 0 |
| `data[17]` | securityStatus | `:21-23` (bit `0x08`=unlocked, `0x10`=authenticated) | 0x00 |
| `data[18]` | passwordProtectionEnabled | `:24` (`!= 0`) | 0x00 |

**Hard requirement:** `data.length > 18` (`:19`) — otherwise `mIsValid` stays false and the
firmware info is discarded (HID flow then never reaches `didAuthenticate`). Our 19-byte
`info[]` satisfies this (`inputstick.c:182-196`).

`securityStatus = 0x00` and `passwordProtection = 0x00` are correct: both the HID and
Utility managers then skip auth (`HIDFirmwareManager.java:104-111`,
`UtilityFirmwareManager.java:391-397`).

> The EMULATION_SPEC §5.1 table claimed Android reads version at `data[3]/data[4]`; that is
> wrong. Android reads `data[1]`/`data[2]` (same as iOS), because Android's `RxPacket` strips
> CRC(4)+cmd(1)+respCode(1) and `getData()` starts at the true data offset.

---

## 6. Hardware-type detection

Detected by the app from GATT — never read from any device-reported byte:

- `BT20Connection` (classic RFCOMM, UUID `00001101`) → `mBluetoothHardwareType = 2`
  (`BT20Connection.java:29-33`). Not emulatable on nRF52840, not needed.
- `BT40Connection` (BLE): scans the discovered services; if `6e400001` service present →
  **type 4 (HW_NRF)**; if `0000ffe0` present → **type 3 (HW_HM)**
  (`BT40Connection.java:79-93`). Constants at `InputStickManager.java:57-61`.

What the type changes:
- `isBluetoothLE() = (type != 2)` (`InputStickDeviceData.java:81-83`) — affects auto-reconnect
  transport.
- `getLatestFirmwareVersion`: 112 (type 4) vs 110 (else) (`UtilConst.java:95-97`) — **display
  only**.
- Firmware-update flash path: NRF vs STM packet sequences (`UtilityFirmwareManager.actionFlash`,
  `:675-681`) — only during an actual flash, which we don't support.

**Conclusion:** we already present the NUS service, so the app detects type 4 correctly. There
is nothing to "report" — type is inferred from the GATT service.

---

## 7. Ranked root causes for "won't connect / won't work"

Most likely first.

1. **ATT MTU = 23, 34-byte notifications dropped (deterministic, blocks typing handshake).**
   `GetFirmwareInfo` reply and `HIDStatusNotification` are 34 B and exceed the 20 B
   notification limit; Zephyr drops them (`att.c:720-724`). The app never negotiates MTU, so
   the HID handshake dies at step 2 with "Firmware init timed out". **Fix:** fragment every
   outgoing InputStick packet into ≤20-byte `bt_gatt_notify` calls (the app reassembles
   byte-wise in `PacketParser.parseReceivedByte`, `BTConnectionManager.onByteRx(byte[])`,
   `PacketParser.java:41-90`), or negotiate a larger ATT MTU from the dongle. This is why iOS
   (which auto-negotiates a larger MTU) could work while Android does not.

2. **`Identify` reply carries no mode byte (deterministic, blocks the management screen).**
   The management UI (`UtilityFirmwareManager`) requires `Identify` reply `data[0] == 0x42
   ('B')` to proceed to `GetFirmwareInfo`; our empty reply leaves `data[0]==0x00` → timeout
   (`UtilityFirmwareManager.java:366-381, 644-653`). The *first-time verify* step still
   passes (it only needs `cmd==0x01`), so the device is saved, but the auto-opened management
   screen errors out. **Fix:** answer `Identify` with one data byte `0x42`.

3. **Only one status notification ever sent (deterministic, blocks sustained typing).**
   `HIDTransactionBuffer` freeSpace is only replenished by 0x2F drain counts; our firmware
   sends a single Ready 0x2F (`inputstick.c:217-233`) and never again, so typing stalls after
   ~128 keyboard reports (~43–64 chars). **Fix:** emit 0x2F every 400 ms (the `SetUpdateInterval`
   param) with `data[7..9]` = drained-report counts, and set the buffer-empty flags correctly.

4. **Firmware version 100 → auto firmware-update prompt.**
   `shouldDisplayFirmwareUpdateMessage()` fires for `version < 101`
   (`InputStickDeviceData.java:179-194`). It's a no-op in the typing service but not
   everywhere. **Fix:** report **101** (major=1, minor=1) — also keeps the management
   "update recommended" nag off (`< 100` gate).

5. **NUS UUID advertised only in the scan response (hardware-dependent, may hide the device).**
   The scanner filters on the `6e400001` service UUID (`DeviceScanner.java:101-115`); our UUID
   is in `sd[]`, not `ad[]` (`ble.c:92-105`). Some Android controllers match the hardware
   `ScanFilter` against the primary ADV only. **Fix:** put the 128-bit UUID in the primary ADV.

Non-issues worth pre-empting (things the spec flagged that are actually fine):
- `data[2]`/`data[4]` boot-protocol flags and `data[11]=0xFF` are **not consumed** by this APK.
- No `CMD_INIT (0x11)` is sent; no hard version-refusal gate exists (`ERROR_FW_UNSUPPORTED_VERSION`
  is never thrown).
- `respCode` is not checked for `RunFirmware`/`GetFirmwareInfo`; our `0x01` is fine.
- Device name "InputStick" is cosmetic only (highlight); connection does not depend on it.

---

## Concrete firmware changes (for reference — no files modified here)

1. `inputstick.c` `ble_notify` path: split each packet into ≤20-byte notifications (the peer
   reassembles). Alternatively raise the ATT MTU, but the app will never request it, so
   fragmentation is the robust fix.
2. `respond_fw_info()`: `info[2] = 1` (version **101**).
3. `Identify` handler: reply with `data[0] = 0x42`.
4. Add a periodic (~400 ms) `HIDStatusNotification` that reports `data[7..9]` drain counts and
   `data[3]/[5]/[6]` buffer-empty flags; keep `data[0]=0x05`.
5. Move the `6e400001` 128-bit UUID into the primary advertising data.
