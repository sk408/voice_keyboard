# SPDX-License-Identifier: Apache-2.0
cmake_minimum_required(VERSION 3.20.0)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(voice_keyboard)

target_include_directories(app PRIVATE src)
target_sources(app PRIVATE
  src/main.c
  src/usb_kbd.c
  src/ble.c
  src/inputstick.c
  # v6.0: src/typing.c (v2..v5 legacy raw ASCII/escape stream) superseded by
  # the InputStick packet protocol — removed from the build; the file stays
  # in the tree as a reference (see DEBUG_NOTES.md v6.0).
  # v5.14: src/macro.c (dongle-stored macro store) excluded — the macro
  # GATT surface hung every v5.x/v5.12/v5.13 build on hardware and is
  # removed for good; the file stays in the tree as a reference
  # (see DEBUG_NOTES.md v5.14).
)
