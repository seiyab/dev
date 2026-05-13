export TERM=xterm-256color

export SAVEHIST=1000
export HISTFILE=~/.history/.zsh_history

source ~/.profile

setopt PROMPT_SUBST
export PROMPT='[$DEV_ENV]%n@%2~ $(git rev-parse --abbrev-ref HEAD)%# '

export LANG=C.utf8

eval "$(direnv hook zsh)"

PATH=$PATH:~/.moon/bin

bindkey -v
