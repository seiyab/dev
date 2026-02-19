#!/usr/bin/env bash
set -euo pipefail

IMAGE=seiyab/dev-mise
NAME=dev-mise

# Start if not already running
if ! container ls --all --format json | jq -e ".[] | select(.configuration.id==\"${NAME}\")" >/dev/null 2>&1; then
  container run -d \
    --name "${NAME}" \
    --user user \
    --publish 9000-9010:8000-8010 \
    --volume "$(pwd)/projects":/home/user/projects \
    --volume history:/home/user/.history \
    --volume config:/home/user/.config \
    --volume mise:/home/user/mise \
    --volume "$(pwd)/scripts":/scripts:ro \
    "${IMAGE}" \
    tail -f /dev/null
fi

# post_start equivalent (run as root)
container exec --user root "${NAME}" /scripts/own-user.sh \
  /home/user/.history /home/user/.config
