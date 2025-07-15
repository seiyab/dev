#!/usr/bin/env bash

set -euo pipefail

for path in "$@"; do
  chown user:user -R "$path"
done

echo "own-user.sh - done: $*"