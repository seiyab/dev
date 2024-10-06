#!/bin/bash
set -e
chown -R user:user /home/user/projects/*
chown -R user:user /home/user/.vscode-server
service ssh start -D
