export TERM=xterm-256color

export SAVEHIST=1000
export HISTFILE=~/.history/.zsh_history

function _git-branch() {
    git branch 2> /dev/null | grep '*' | sed -n -e 's/^\* \(.*\)/[\1] /p'
}

setopt PROMPT_SUBST
export PROMPT='%n@%2~ $(_git-branch)%# '

bindkey -v