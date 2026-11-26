#!/usr/bin/env bash
# Run the real driver on a private synthetic display, never on the user's desktop.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ "$(uname -s)" == Linux ]] || { echo 'Computer X11 acceptance requires Linux.' >&2; exit 1; }
for tool in Xvfb xvfb-run xauth xsetroot dbus-run-session python3 node; do
  command -v "$tool" >/dev/null || { echo "Computer X11 acceptance requires $tool." >&2; exit 1; }
done
python3 -c 'import gi; gi.require_version("Atspi", "2.0"); gi.require_version("Gdk", "3.0"); from gi.repository import Atspi, Gdk, GdkPixbuf'
fixture="$(mktemp -d /tmp/varin-x11.XXXXXX)"
trap 'rm -rf -- "$fixture"' EXIT
mkdir -m 700 "$fixture/runtime"
# The authority runner formats generated Rust using the runner's installed
# toolchain. Keep only that toolchain location, not the host desktop HOME.
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export XDG_RUNTIME_DIR="$fixture/runtime"
export HOME="$fixture"
export XDG_SESSION_TYPE=x11
unset DISPLAY WAYLAND_DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS
# xvfb-run creates a private Xauthority cookie and sets DISPLAY for the child.
xvfb-run -a -s '-screen 0 320x240x24 -nolisten tcp -noreset' dbus-run-session -- bash -euc '
  xsetroot -solid "#3060c0"
  export VARIN_TEST_COMPUTER_X11=1
  node scripts/test-kernel-authority.mjs \
    --vitest-file=computer-node-x11.native.test.ts
'
