# bash completion for forgejo. Generated from the Command catalog; do not edit.
_forgejo() {
  local cur family words
  cur=${COMP_WORDS[COMP_CWORD]}
  family=${COMP_WORDS[1]}
  if [ "$COMP_CWORD" -eq 1 ]; then
    words="api auth issue pr repo run smoke workflow --version"
  else
    case "$family" in
    auth) words="login status logout --agent" ;;
    issue) words="list view create edit close reopen comment delete pin unpin status --agent" ;;
    pr) words="list view create edit comment diff checkout checks review merge --agent" ;;
    repo) words="list view clone create edit rename archive unarchive delete fork --agent" ;;
    run) words="list view cancel delete download watch rerun --agent" ;;
    smoke) words="echo --agent" ;;
    workflow) words="list view run --agent" ;;
      *) words="--agent --dry-run --approve --input-output" ;;
    esac
  fi
  COMPREPLY=( $(compgen -W "$words" -- "$cur") )
}
complete -F _forgejo forgejo
