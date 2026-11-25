[[ -r ~/.profile ]] && source ~/.profile

export LANG=C.utf8

PATH=$PATH:~/.moon/bin

bindkey -v

HISTSIZE=20000
SAVEHIST=10000
HISTFILE=~/.history/.zsh_history
mkdir -p -- "${HISTFILE:h}"
setopt SHARE_HISTORY

autoload -Uz add-zsh-hook

workbench_prompt() {
  local ref dev_env=${DEV_ENV//\%/%%}
  ref=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) ||
    ref=$(git rev-parse --short HEAD 2>/dev/null)
  PROMPT="${dev_env:+[$dev_env]}%n@%~${ref:+ (${ref//\%/%%})}%# "
}

add-zsh-hook precmd workbench_prompt
