#!/bin/sh
# Git asks this for a GitHub identity's credentials during one push or fetch polyphemus runs itself.
# The token is only in that git process's environment — never in a URL, a config file or an agent's shell.
# It's only given to the host polyphemus meant: git names it in the prompt ("Password for
# 'https://x-access-token@github.com': "), and a URL rewrite in the repository's config would name another.
case "$1" in
  *"://$POLYPHEMUS_GIT_HOST'"*|*"@$POLYPHEMUS_GIT_HOST'"*) ;;
  *) exit 1 ;;
esac
case "$1" in
  Username*) printf '%s\n' "x-access-token" ;;
  *) printf '%s\n' "$POLYPHEMUS_GIT_TOKEN" ;;
esac
