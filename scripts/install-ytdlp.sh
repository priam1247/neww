#!/usr/bin/env bash
# Installs yt-dlp for hosts where pip is unavailable or the environment is
# "externally managed" (Debian/Ubuntu 23+, Katabump, Pterodactyl images, …).
# The bot can also do this by itself at runtime (.ytdl repair / automatic).
set -u
cd "$(dirname "$0")/.."

# yt-dlp is usable either as a command or as a python module
have_ytdlp() {
  if command -v yt-dlp >/dev/null 2>&1; then yt-dlp --version >/dev/null 2>&1 && return 0; fi
  python3 -m yt_dlp --version >/dev/null 2>&1 && return 0
  return 1
}

have_ytdlp && { echo "✅ yt-dlp already installed: $(yt-dlp --version 2>/dev/null || python3 -m yt_dlp --version)"; exit 0; }

echo "→ trying pip (user install, break-system-packages allowed)…"
# Debian/Ubuntu 23+ and most panels mark the system python as "externally
# managed"; without --break-system-packages pip refuses to install anything.
python3 -m pip install --user -q --break-system-packages --upgrade yt-dlp 2>/dev/null \
  || python3 -m pip install -q --break-system-packages --upgrade yt-dlp 2>/dev/null \
  || pip3 install --user -q --break-system-packages --upgrade yt-dlp 2>/dev/null \
  || python3 -m pip install --user -q --upgrade yt-dlp 2>/dev/null \
  || true

if have_ytdlp; then
  echo "✅ yt-dlp installed: $(yt-dlp --version 2>/dev/null || python3 -m yt_dlp --version)"
  exit 0
fi

echo "→ pip did not work, downloading the standalone binary into ./bin …"
mkdir -p bin
if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 3 -o bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
elif command -v wget >/dev/null 2>&1; then
  wget -O bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
else
  echo "❌ neither curl nor wget available"; exit 1
fi
chmod +x bin/yt-dlp
./bin/yt-dlp --version && echo "✅ standalone yt-dlp ready at ./bin/yt-dlp"
