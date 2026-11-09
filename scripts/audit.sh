#!/usr/bin/env bash
# audit.sh — 主動守護稽核工具：檢查 staged 或近期改動是否違反 agent-working-agreements 守則。
#
# 用法：
#   scripts/audit.sh                # 優先檢查 staged 暫存區，若無暫存則檢查最近一次 commit
#   scripts/audit.sh --staged       # 明確只檢查 staged 暫存區（或 --cached）
#   scripts/audit.sh --diff         # 檢查工作區尚未暫存的修改 (Unstaged diff)
#   scripts/audit.sh --commit HEAD  # 檢查指定 commit
#   scripts/audit.sh --install-hook # 安裝為 Git pre-commit hook（既有 hook 會備份並串接執行）
#   scripts/audit.sh --install-pre-push # 安裝 Git pre-push hook（擋 force push；hook-guard.sh --install-git-hooks 會呼叫）
#
# 結束碼：0 合規；1 發現嚴重違規 (FAIL)；2 參數錯誤。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

mode="auto"
target_ref=""

while [ $# -gt 0 ]; do
  case "$1" in
    --cached|--staged) mode="cached"; shift ;;
    --diff) mode="diff"; shift ;;
    --commit) [ $# -ge 2 ] || { echo "✗ --commit 需要指定 ref" >&2; exit 2; }; target_ref="$2"; mode="commit"; shift 2 ;;
    --install-hook) mode="install-hook"; shift ;;
    --install-pre-push) mode="install-pre-push"; shift ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) echo "✗ 未知參數：$1" >&2; exit 2 ;;
  esac
done

# ── 安裝 Git Hook ─────────────────────────────────────
# hooks 目錄以 git rev-parse --git-path hooks 為準（支援 worktree 與 core.hooksPath）。
# 既有的非本 repo hook 會備份成 <name>.agreements-bak，並在守門檢查通過後接著執行。

HOOK_MARK="由 agent-working-agreements 安裝"

resolve_hooks_dir() {
  local top rel
  top="$(git rev-parse --show-toplevel 2>/dev/null)" || return 1
  rel="$(cd "$top" && git rev-parse --git-path hooks 2>/dev/null)" || return 1
  (cd "$top" && mkdir -p "$rel" && cd "$rel" && pwd -P)
}

# write_hook <hooks 目錄> <hook 名稱> <內容>
write_hook() {
  local file="$1/$2" bak="$1/$2.agreements-bak"
  if [ -f "$file" ] && ! grep -q "$HOOK_MARK" "$file"; then
    [ -e "$bak" ] && mv "$bak" "$bak.$(date +%Y%m%d%H%M%S)"
    mv "$file" "$bak"
    echo "ℹ 既有的 $2 hook 已備份為 $(basename "$bak")，守門檢查通過後會接著執行它"
  fi
  printf '%s\n' "$3" > "$file"
  chmod +x "$file"
}

pre_commit_body() {
  local self
  self="$(printf '%q' "$ROOT/scripts/audit.sh")"
  cat <<EOF
#!/usr/bin/env bash
# ${HOOK_MARK}的 pre-commit 守門檢查（scripts/audit.sh --staged），會串接執行 pre-commit.agreements-bak
hook_dir="\$(cd "\$(dirname "\$0")" && pwd)"
audit=""
for cand in "\$(git rev-parse --show-toplevel)/scripts/audit.sh" ${self}; do
  if [ -f "\$cand" ]; then audit="\$cand"; break; fi
done
if [ -n "\$audit" ]; then
  bash "\$audit" --staged || exit \$?
else
  echo "⚠ [agent-agreements] 找不到 scripts/audit.sh，略過 pre-commit 稽核（可執行 /agreements:doctor fix 重新安裝 hook）" >&2
fi
if [ -x "\$hook_dir/pre-commit.agreements-bak" ]; then
  exec "\$hook_dir/pre-commit.agreements-bak" "\$@"
fi
exit 0
EOF
}

pre_push_body() {
  cat <<EOF
#!/usr/bin/env bash
# ${HOOK_MARK}的 pre-push 守門防線：擋下非 fast-forward 的 force push，會串接執行 pre-push.agreements-bak
set -uo pipefail
hook_dir="\$(cd "\$(dirname "\$0")" && pwd)"
input="\$(cat)"
EOF
  cat <<'EOF'

prohibit_disable=0
for cand in ".agreements.json" ".agreementsrc"; do
  if [ -f "$cand" ] && tr '\n' ' ' < "$cand" | grep -qE '"prohibit_disable_hooks"[[:space:]]*:[[:space:]]*true([^A-Za-z0-9_]|$)'; then
    prohibit_disable=1; break
  fi
done

guard_enabled=1
if [ "$prohibit_disable" -eq 0 ] && [ -n "${AGREEMENTS_HOOKS_DISABLE:-}" ] && [ "$AGREEMENTS_HOOKS_DISABLE" != "0" ]; then
  guard_enabled=0
fi

zero="0000000000000000000000000000000000000000"
if [ "$guard_enabled" -eq 1 ]; then
  while read -r local_ref local_sha remote_ref remote_sha; do
    [ -z "${local_ref:-}" ] && continue
    [ "${local_sha:-}" = "$zero" ] && continue
    [ -n "${remote_sha:-}" ] && [ "$remote_sha" != "$zero" ] || continue
    if ! git cat-file -e "${remote_sha}^{commit}" 2>/dev/null; then
      echo "🛑 [agent-agreements] 觸發 git-safety 守則攔截：本機沒有遠端分支 ${remote_ref:-} 目前的 commit，無法確認這次推送不會覆寫別人的提交。" >&2
      echo "💡 請先 git fetch 並整合遠端變更後再推送。" >&2
      exit 1
    fi
    if ! git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
      echo "🛑 [agent-agreements] 觸發 git-safety 守則攔截：偵測到非快進 (Force Push) 覆蓋遠端分支 ${remote_ref:-}！" >&2
      echo "💡 這個 hook 看不到 --force-with-lease 等旗標，任何覆寫遠端都會擋。確實需要（例如 rebase 後）請先取得團隊同意，再以 AGREEMENTS_HOOKS_DISABLE=1 git push … 執行（團隊策略設 prohibit_disable_hooks 時無法略過）。" >&2
      exit 1
    fi
  done <<< "$input"
fi

if [ -x "$hook_dir/pre-push.agreements-bak" ]; then
  # 用 here-string 而不是管線：被串接的 hook 不讀 stdin 就結束時，管線可能收到 SIGPIPE 而誤判失敗
  if [ -n "$input" ]; then
    "$hook_dir/pre-push.agreements-bak" "$@" <<< "$input"
  else
    "$hook_dir/pre-push.agreements-bak" "$@" < /dev/null
  fi
  exit $?
fi
exit 0
EOF
}

if [ "$mode" = "install-hook" ] || [ "$mode" = "install-pre-push" ]; then
  hooks_dir="$(resolve_hooks_dir)" || { echo "✗ 目前目錄不在 git repo 內，無法安裝 hook" >&2; exit 1; }
  if [ "$mode" = "install-hook" ]; then
    write_hook "$hooks_dir" pre-commit "$(pre_commit_body)"
    echo "✓ 已成功安裝 pre-commit hook：$hooks_dir/pre-commit"
  else
    write_hook "$hooks_dir" pre-push "$(pre_push_body)"
    echo "✓ 已成功安裝 pre-push hook (防 Force Push)：$hooks_dir/pre-push"
  fi
  exit 0
fi

# ── 決定比對範圍 ─────────────────────────────────────

diff_cmd=""
name_cmd=""
scope_desc=""

if [ "$mode" = "cached" ] || { [ "$mode" = "auto" ] && [ -n "$(git diff --cached --name-only 2>/dev/null)" ]; }; then
  diff_cmd="git diff --cached"
  name_cmd="git diff --cached --name-only"
  scope_desc="Git 暫存區 (Staged)"
elif [ "$mode" = "diff" ]; then
  diff_cmd="git diff"
  name_cmd="git diff --name-only"
  scope_desc="工作區修改 (Diff)"
elif [ "$mode" = "commit" ]; then
  diff_cmd="git show -m --format= $target_ref"
  name_cmd="git diff-tree -m --no-commit-id --name-only -r $target_ref"
  scope_desc="Commit $target_ref"
else
  diff_cmd="git show -m --format= HEAD"
  name_cmd="git diff-tree -m --no-commit-id --name-only -r HEAD"
  scope_desc="最近一次 Commit (HEAD)"
fi

files="$($name_cmd 2>/dev/null || true)"
if [ -z "$files" ]; then
  echo "（${scope_desc} 沒有變更檔案，略過稽核）"
  exit 0
fi

echo "▸ 執行 agent 守則合規稽核 [範圍：${scope_desc}]"

fails=0
warns=0

fail() { echo "  ✗ [FAIL] $1" >&2; fails=$((fails + 1)); }
warn() { echo "  ! [WARN] $1"; warns=$((warns + 1)); }
pass() { echo "  ✓ [PASS] $1"; }

# 1. 個資與資料檔案檢查 (rules/security/data-files.md)
sensitive_files="$(printf '%s\n' "$files" | grep -E '\.(csv|xlsx|sql|env(\..+)?)$|^storage/|^data/' || true)"
if [ -n "$sensitive_files" ]; then
  fail "發現敏感或資料檔案被暫存（請確認是否符合 data-files 守則）："
  printf '%s\n' "$sensitive_files" | sed 's/^/      - /' >&2
else
  pass "無敏感或未審查的資料檔案暫存"
fi

# 2. 靜默吞噬例外檢查 (rules/api/pitfalls.md) — 排除 markdown 文件
code_files="$(printf '%s\n' "$files" | grep -v -E '\.md$' | grep -E '\.(php|py|js|ts|jsx|tsx|vue|go|java|rb|rs|c|cpp|cs)$' || true)"
if [ -n "$code_files" ]; then
  code_diff="$($diff_cmd -- $code_files 2>/dev/null || true)"
  swallowed="$(printf '%s\n' "$code_diff" | awk '
    /^\+[^+]/ {
      line = $0
      sub(/^\+/, "", line)
      buf = buf "\n" line
      next
    }
    {
      if (buf ~ /catch[^{]*\{[[:space:]]*(\/\*.*\*\/|\/\/[^\n]*)?[[:space:]]*\}|except[^:]*:[[:space:]]*(pass|\.\.\.)/) { found = 1 }
      buf = ""
    }
    END {
      if (buf ~ /catch[^{]*\{[[:space:]]*(\/\*.*\*\/|\/\/[^\n]*)?[[:space:]]*\}|except[^:]*:[[:space:]]*(pass|\.\.\.)/) { found = 1 }
      if (found) print "swallowed"
    }')"
  if [ -n "$swallowed" ]; then
    fail "檢測到靜默吞噬例外的空 catch/except 區塊（違反 api/pitfalls 守則）"
  else
    pass "無靜默吞噬例外的空 catch 區塊"
  fi
else
  pass "未觸及程式碼檔案或無程式碼異動"
fi

# 3. 測試完整性檢查 (rules/collaboration/test-integrity.md)
test_files="$(printf '%s\n' "$files" | grep -E 'test|spec' || true)"
if [ -n "$test_files" ]; then
  test_diff="$($diff_cmd -- $test_files 2>/dev/null || true)"
  del_asserts="$(printf '%s\n' "$test_diff" | grep -E '^\-[^-]' | grep -c -E 'assert|expect\(|@test' || true)"
  add_asserts="$(printf '%s\n' "$test_diff" | grep -E '^\+[^+]' | grep -c -E 'assert|expect\(|@test' || true)"
  if [ "$del_asserts" -gt "$add_asserts" ]; then
    warn "檢測到測試斷言被刪除（減少 $((del_asserts - add_asserts)) 個斷言），請確認是否為了變綠而改測試"
  else
    pass "測試完整性正常（未發現斷言異常減少）"
  fi
else
  pass "未觸及測試檔案或無測試異動"
fi

# 4. 動態 Tailwind Class Purge 檢查 (rules/frontend/pitfalls.md)
front_files="$(printf '%s\n' "$files" | grep -E '\.(vue|jsx|tsx|svelte|html)$' || true)"
if [ -n "$front_files" ]; then
  front_diff="$($diff_cmd -- $front_files 2>/dev/null || true)"
  dyn_classes="$(printf '%s\n' "$front_diff" | grep -E '^\+[^+]' | grep -E '(:class|className)=["'\''{][^"'\''}]*['\''"`][a-z]+-[a-z0-9]*-?['\''"`][[:space:]]*(\+|\$)' || true)"
  if [ -n "$dyn_classes" ]; then
    warn "檢測到動態字串拼接 class（可能在生產 build 時被 Tailwind purge 移除，見 frontend/pitfalls）"
  else
    pass "前端 class 完整性正常"
  fi
else
  pass "無前端 template/樣式變更"
fi

# 5. 除錯語句殘留檢查 (rules/collaboration/verification.md)
if [ -n "$code_files" ]; then
  debug_diff="$($diff_cmd -- $code_files 2>/dev/null || true)"
  debug_statements="$(printf '%s\n' "$debug_diff" | grep -E '^\+[^+]' | grep -E '\b(console\.log|dd\(|dump\(|debugger;|breakpoint\(\)|var_dump\()' || true)"
  if [ -n "$debug_statements" ]; then
    warn "檢測到可能殘留的除錯語句（console.log / dd / debugger），請確認是否為測試除錯遺留"
  else
    pass "無明顯除錯語句殘留"
  fi
fi

# 6. 高危權限與指令檢查 (rules/security/supply-chain.md)
sec_diff="$($diff_cmd 2>/dev/null || true)"
high_risk="$(printf '%s\n' "$sec_diff" | grep -E '^\+[^+]' | grep -E '\bchmod\s+777\b|"Action"\s*:\s*"\*"|"Resource"\s*:\s*"\*"' || true)"
if [ -n "$high_risk" ]; then
  warn "檢測到高危全開放權限（chmod 777 或 Wildcard IAM 授權，見 security/supply-chain）"
else
  pass "無高危全開放權限變更"
fi

# 7. Git 分支安全檢查 (rules/collaboration/git-safety.md)
branch="$(git branch --show-current 2>/dev/null || true)"
if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
  warn "目前位於主分支「${branch}」，功能與重大重構請開分支走 PR"
else
  pass "當前工作分支符合隔離規範 (${branch})"
fi

echo "──"
echo "稽核結果：FAIL ${fails}｜WARN ${warns}"

if [ "$fails" -gt 0 ]; then
  echo "✗ 稽核未通過，請修正上述 FAIL 項目後再繼續。" >&2
  exit 1
fi

echo "✓ 稽核通過"
exit 0
