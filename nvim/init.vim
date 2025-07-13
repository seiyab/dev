" https://github.com/Shougo/dein.vim/blob/dd5e1cc6ce869253b9c68284d6d885f75bfcfd6a/README.md
let $CACHE = expand('~/.cache')
if !($CACHE->isdirectory())
  call mkdir($CACHE, 'p')
endif
if &runtimepath !~# '/dein.vim'
  let s:dir = 'dein.vim'->fnamemodify(':p')
  if !(s:dir->isdirectory())
    let s:dir = $CACHE .. '/dein/repos/github.com/Shougo/dein.vim'
    if !(s:dir->isdirectory())
      execute '!git clone https://github.com/Shougo/dein.vim' s:dir
    endif
  endif
  execute 'set runtimepath^='
        \ .. s:dir->fnamemodify(':p')->substitute('[/\\]$', '', '')
endif

set nocompatible

let s:dein_base = '~/.cache/dein/'
let s:dein_src = '~/.cache/dein/repos/github.com/Shougo/dein.vim'
execute 'set runtimepath+=' .. s:dein_src
call dein#begin(s:dein_base)
call dein#add(s:dein_src)

" Your plugins go here:
call dein#add('nvim-lua/plenary.nvim')
call dein#add('nvim-telescope/telescope.nvim', { 'rev': '0.1.8' })

call dein#end()
