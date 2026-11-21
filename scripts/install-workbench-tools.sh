#!/bin/sh
set -eu

# Keep both Docker Desktop architectures pinned to verified release archives.
# Optional prefix allows checking the installer without modifying the host.
prefix="${1:-/usr/local}"
case "$(dpkg --print-architecture)" in
    arm64)
        nvim_arch=arm64
        nvim_sha=8f1f64a0bdb97247034038c3823c6cbad5bdf9ecd5751b85494b71c3ee04c815
        lazygit_arch=arm64
        lazygit_sha=ac0b48237f3d0283813e7154ec063237e519532feb0470c0881a1793ee78fd42
        ;;
    amd64)
        nvim_arch=x86_64
        nvim_sha=474430d53e6264f6d6dd18db42d6dc9df3a1b56ca9e88a325bbf860e1a811d87
        lazygit_arch=x86_64
        lazygit_sha=0a23f429a95f0d09db298b3c291536d818de066aa5a85c255806f0490ff6656b
        ;;
    *) echo "Unsupported workbench architecture" >&2; exit 1 ;;
esac

tools_tmp="$(mktemp -d)"
trap 'rm -rf "$tools_tmp"' EXIT HUP INT TERM
curl -fL --retry 3 -o "$tools_tmp/nvim.tar.gz" \
    "https://github.com/neovim/neovim/releases/download/v0.12.6/nvim-linux-${nvim_arch}.tar.gz"
printf '%s  %s\n' "$nvim_sha" "$tools_tmp/nvim.tar.gz" | sha256sum --check
mkdir -p "$prefix"
tar -xzf "$tools_tmp/nvim.tar.gz" -C "$prefix" --strip-components=1

curl -fL --retry 3 -o "$tools_tmp/lazygit.tar.gz" \
    "https://github.com/jesseduffield/lazygit/releases/download/v0.66.3/lazygit_0.66.3_linux_${lazygit_arch}.tar.gz"
printf '%s  %s\n' "$lazygit_sha" "$tools_tmp/lazygit.tar.gz" | sha256sum --check
tar -xzf "$tools_tmp/lazygit.tar.gz" -C "$tools_tmp" lazygit
install -m 0755 "$tools_tmp/lazygit" "$prefix/bin/lazygit"
