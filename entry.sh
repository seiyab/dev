set -e
chown -R user:user /home/user/projects
chown user:user /home/user/.zshrc
service ssh start -D
