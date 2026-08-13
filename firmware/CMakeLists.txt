# SPDX-License-Identifier: Apache-2.0
cmake_minimum_required(VERSION 3.20.0)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(voice_keyboard)

target_include_directories(app PRIVATE src)
target_sources(app PRIVATE
  src/main.c
  src/usb_kbd.c
  src/ble.c
  src/typing.c
  # v5.6: src/macro.c (v5 macro store) excluded — the macro GATT surface
  # hung every v5.x build on hardware; re-add incrementally later
  # (see DEBUG_NOTES.md v5.6 for what to restore).
)
