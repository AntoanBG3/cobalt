#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

wizard_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd -- "${1:?usage: apply-patches.sh UPSTREAM_CHECKOUT}"

# These upstream changes overlap older wizard patches. If the exact upstream
# diff is present, undo its duplicate before applying the full wizard stack.
for patch in "$wizard_dir"/upstream-backports/*.patch; do
    if git apply --reverse --check "$patch" 2>/dev/null; then
        git apply --reverse "$patch"
        echo "using wizard backport: ${patch##*/}"
    fi
done

for patch in "$wizard_dir"/patches/*.patch; do
    if git apply --check "$patch" 2>/dev/null; then
        git apply "$patch"
        echo "applied: ${patch##*/}"
    elif git apply --reverse --check "$patch" 2>/dev/null; then
        echo "already upstream, skipped: ${patch##*/}"
    else
        echo "::error::patch no longer applies: ${patch##*/}"
        git apply --check "$patch"
    fi
done
