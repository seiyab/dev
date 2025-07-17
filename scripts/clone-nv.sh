#!/usr/bin/env bash

set -euo pipefail

if [ ! -d ~/.config/nvim ]; then
  git clone git@github.com:seiyab/nv.git ~/.config/nvim
fi
