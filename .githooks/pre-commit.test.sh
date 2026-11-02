#!/usr/bin/env bash
# Tests for pre-commit, in a throwaway repo: bash .githooks/pre-commit.test.sh
set -euo pipefail

hook=$(cd "$(dirname "$0")" && pwd)/pre-commit
token="sk-ant-$(printf 'A1b2%.0s' 1 2 3 4 5 6)"  # built here so no key-shaped text is committed
fails=0

g() { git -c commit.gpgsign=false -c user.name=t -c user.email=t@example.com -c core.hooksPath=/dev/null "$@" >/dev/null; }
fresh() {
  repo=$(mktemp -d); cd "$repo"; g init -q
  seq 1 20 | sed 's/^/line /' > notes.md  # long enough for git to call a moved copy a rename
  g add notes.md; g commit -q -m init
}
expect() {  # expect <exit code> <case>
  local got=0; bash "$hook" 2>/dev/null || got=$?
  if [ "$got" = "$1" ]; then echo "ok   $2"; else echo "FAIL $2 (exit $got, want $1)"; fails=1; fi
  cd /; rm -rf "$repo"
}

fresh; echo world >> notes.md; g add notes.md; expect 0 "a clean change passes"
fresh; mkdir docs; g mv notes.md docs/notes.md; echo "$token" >> docs/notes.md; g add docs/notes.md
[ "$(git diff --cached --name-status | cut -c1)" = R ] || { echo "FAIL git saw no rename"; fails=1; }
expect 1 "a secret in a renamed file is caught"
fresh; echo "$token" > "my notes.md"; g add "my notes.md"; expect 1 "a secret in a path with a space is caught"
fresh; echo "$token" > café.md; g add café.md; expect 1 "a secret in a non-ASCII path is caught"
fresh; { echo "$token"; seq 1 300000; } > big.txt; g add big.txt; expect 1 "a secret before a large diff is caught"
exit $fails
