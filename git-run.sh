#!/usr/bin/env bash
set -euo pipefail

IMAGE=seiyab/dev-mise
NAME=dev-git

# Start if not already running
if ! container ls --all --format json | jq -e ".[] | select(.configuration.id==\"${NAME}\")" >/dev/null 2>&1; then
  container run -d \
    --name "${NAME}" \
    --user user \
    --volume "$(pwd)/projects":/home/user/projects \
    --volume "$(pwd)/scripts":/scripts:ro \
    --volume ${SSH_AUTH_SOCK}:/tmp/ssh-agent.sock \
    --env SSH_AUTH_SOCK=/tmp/ssh-agent.sock \
    --env DEV_ENV=git \
    "${IMAGE}" \
    tail -f /dev/null
fi

container exec --user user "${NAME}" /scripts/git-config.sh
