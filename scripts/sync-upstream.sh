#!/usr/bin/env bash
set -euo pipefail

UPSTREAM_REPO='git@github.com:firekula/mcp-bridge.git'
UPSTREAM_BRANCH='main'
BASE_BRANCH='main'
SKIP_PUSH_BASE=0
PUSH_CURRENT_BRANCH=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-push-base) SKIP_PUSH_BASE=1 ;;
        --push-current-branch) PUSH_CURRENT_BRANCH=1 ;;
        *) echo "[ERR] 未知参数: $1"; exit 1 ;;
    esac
    shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
    echo '[ERR] 工作区存在未提交修改，请先提交或暂存。'
    git -C "$REPO_ROOT" status --short
    exit 1
fi

CURRENT_BRANCH="$(git -C "$REPO_ROOT" branch --show-current)"
[[ -n "$CURRENT_BRANCH" ]] || { echo '[ERR] 不支持 detached HEAD。'; exit 1; }

if git -C "$REPO_ROOT" remote get-url upstream >/dev/null 2>&1; then
    git -C "$REPO_ROOT" remote set-url upstream "$UPSTREAM_REPO"
else
    git -C "$REPO_ROOT" remote add upstream "$UPSTREAM_REPO"
fi

git -C "$REPO_ROOT" fetch origin --prune
if [[ "$(git -C "$REPO_ROOT" rev-parse --is-shallow-repository)" == 'true' ]]; then
    git -C "$REPO_ROOT" fetch origin --unshallow
fi
git -C "$REPO_ROOT" fetch origin "$BASE_BRANCH:refs/remotes/origin/$BASE_BRANCH" || true
git -C "$REPO_ROOT" fetch upstream --prune
git -C "$REPO_ROOT" show-ref --verify --quiet "refs/remotes/upstream/$UPSTREAM_BRANCH" || {
    echo "[ERR] 找不到 upstream/$UPSTREAM_BRANCH。"
    exit 1
}

if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BASE_BRANCH"; then
    git -C "$REPO_ROOT" switch "$BASE_BRANCH"
elif git -C "$REPO_ROOT" show-ref --verify --quiet "refs/remotes/origin/$BASE_BRANCH"; then
    git -C "$REPO_ROOT" switch --track -c "$BASE_BRANCH" "origin/$BASE_BRANCH"
else
    git -C "$REPO_ROOT" switch -c "$BASE_BRANCH" "upstream/$UPSTREAM_BRANCH"
fi

if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/remotes/origin/$BASE_BRANCH"; then
    git -C "$REPO_ROOT" merge --ff-only "origin/$BASE_BRANCH"
fi
git -C "$REPO_ROOT" merge --ff-only "upstream/$UPSTREAM_BRANCH"
if [[ $SKIP_PUSH_BASE -eq 0 ]]; then
    git -C "$REPO_ROOT" push origin "$BASE_BRANCH"
fi

if [[ "$CURRENT_BRANCH" != "$BASE_BRANCH" ]]; then
    git -C "$REPO_ROOT" switch "$CURRENT_BRANCH"
    git -C "$REPO_ROOT" merge --no-edit "$BASE_BRANCH"
    if [[ $PUSH_CURRENT_BRANCH -eq 1 ]]; then
        git -C "$REPO_ROOT" push origin "$CURRENT_BRANCH"
    fi
fi

echo "[OK] upstream/$UPSTREAM_BRANCH -> $BASE_BRANCH -> $CURRENT_BRANCH"
