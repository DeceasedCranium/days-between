#!/bin/bash
# install-pkg.sh — install the most recent locally-built Days Between
# package via pacman, with --overwrite so files added by `days-update.sh`
# rsyncs (which pacman doesn't track) don't cause conflicts.
#
# Usage:  ./install-pkg.sh
#         ./install-pkg.sh days-between-1.12.0-1-any.pkg.tar.zst   # explicit
#
# Without an argument it picks the newest *.pkg.tar.zst in the repo root.

set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"

if [ $# -ge 1 ]; then
  PKG="$1"
else
  PKG="$(ls -t "$REPO"/days-between-*.pkg.tar.zst 2>/dev/null | head -1)"
fi

if [ -z "${PKG:-}" ] || [ ! -f "$PKG" ]; then
  echo "No package found. Build one first with:" >&2
  echo "    cd \"$REPO\" && makepkg -f" >&2
  exit 1
fi

echo "Installing $(basename "$PKG")..."
sudo pacman -U --noconfirm --overwrite "/opt/days-between/*" "$PKG"
echo "Done. Relaunch Days Between from the taskbar."
