#!/bin/bash
set -e

# Script lives at <repo>/scripts/local/, so $REPO is two dirs up from
# the resolved-symlink path of $0.
REPO="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"

echo "Pulling latest..."
git -C "$REPO" pull

echo "Syncing to /opt/days-between..."
sudo rsync -a --delete \
  "$REPO/app" \
  "$REPO/assets" \
  "$REPO/package.json" \
  /opt/days-between/

echo "Done. Relaunch Days Between from the taskbar."
