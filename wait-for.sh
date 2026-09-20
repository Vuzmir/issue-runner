#!/bin/sh
# Blocks until a command finishes and leaves a marker file behind recording how it went - the
# one thing worth polling for when the command cannot be bounded by a single Bash call's
# timeout (the CLI caps that at 600000ms / 10 minutes), or backgrounds itself regardless of
# how it was invoked.
#
# Usage: sh wait-for.sh <marker-file> <command...>
#
# Start this with Bash's run_in_background:true, then block on the real result with the
# Monitor tool's until-loop against <marker-file>, which exists only once <command...> has
# actually exited - never before:
#
#   until [ -f "<marker-file>" ]; do sleep 2; done; cat "<marker-file>"
#
# <marker-file> holds the exit status alone. The command's own stdout and stderr still land
# wherever run_in_background already sends them - this only answers "is it done yet".

marker="$1"
shift
"$@"
status=$?
printf '%s' "$status" > "$marker"
exit "$status"
