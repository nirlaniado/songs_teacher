#!/usr/bin/env bash
# Native build + run of the LOK capability probe. No Docker — see CLAUDE.md
# for why native WSL is the daily loop now that libreofficekit-dev ships on
# Ubuntu 24.04.
set -euo pipefail
cd "$(dirname "$0")"

LO_PROGRAM_PATH="${LO_PROGRAM_PATH:-/home/nir20/guitar_teacher/lo-clean-build/instdir/program}"
OUT_DIR="$(pwd)/out"
mkdir -p "$OUT_DIR"

# LibreOffice requires a writable HOME for its user profile; a read-only or
# unset HOME fails in confusing ways rather than a clear error (BUILD.md §4).
export HOME="${HOME:-/tmp/loprofile}"
mkdir -p "$HOME"
export SAL_USE_VCLPLUGIN=svp

echo "== compiling =="
# LOK is dlopen'd at runtime from LO_PROGRAM_PATH, so there is no
# -llibreoffice to link — -ldl is what the LOK init shim needs.
g++ -std=c++17 -O2 -o probe probe.cpp -ldl

echo "== running =="
./probe "$LO_PROGRAM_PATH" "$OUT_DIR"
