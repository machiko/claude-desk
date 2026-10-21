#!/bin/sh
# 發布前檢查：掃描所有要進版控的檔案，不得出現 .public-denylist 裡的字詞（一行一個，# 開頭是註解，大小寫不分）。
# 清單本身不進版控（見 .gitignore），免得清單洩漏要藏的名稱。
# 用法：sh scripts/check-public.sh；有命中時 exit 1 並列出檔案與行號；找不到清單時 exit 2。
# 掃描範圍是腳本所在的 worktree；清單依序找 $CHECK_PUBLIC_DENYLIST、worktree 根目錄、主 repo 根目錄（worktree 裡通常沒有清單）。
# 變數一律寫 ${var}：bash 在 UTF-8 locale 下會把 $var 後面的全形標點（例如「：」）吃進變數名，報 unbound variable。
set -eu
cd "$(dirname "$0")/.."
if top=$(git rev-parse --show-toplevel 2>/dev/null); then
  cd "${top}"
fi
name=.public-denylist
main_root=
if common=$(git rev-parse --git-common-dir 2>/dev/null); then
  main_root=$(cd "${common}/.." && pwd)
fi
list=${CHECK_PUBLIC_DENYLIST:-}
if [ -z "${list}" ]; then
  if [ -f "${name}" ]; then
    list=${name}
  elif [ -n "${main_root}" ] && [ -f "${main_root}/${name}" ]; then
    list=${main_root}/${name}
  else
    echo "沒有 ${name}：先在主 repo 根目錄（${main_root:-$(pwd)}）建立禁用字詞清單（一行一個），或用 CHECK_PUBLIC_DENYLIST 指定路徑" >&2
    exit 2
  fi
fi
[ -f "${list}" ] || { echo "找不到 CHECK_PUBLIC_DENYLIST 指定的清單：${list}" >&2; exit 2; }
tmp=$(mktemp -d)
trap 'rm -rf "${tmp}"' EXIT
grep -v '^[[:space:]]*\(#\|$\)' "${list}" > "${tmp}/patterns" || true
[ -s "${tmp}/patterns" ] || { echo "${list} 是空的" >&2; exit 2; }
# 有 git 就只看會進版控的檔案；還沒 git init 就看全部（略過被忽略的型別檔）。
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git ls-files --cached --others --exclude-standard > "${tmp}/files"
else
  find . -type f ! -path './.git/*' ! -path './.claude-plugin/types/*' | sed 's#^\./##' > "${tmp}/files"
fi
grep -v -x -F -e "${name}" -e "${list}" "${tmp}/files" > "${tmp}/scan" || true
count=$(grep -c . "${tmp}/scan" || true)
if tr '\n' '\0' < "${tmp}/scan" | xargs -0 -r grep -n -I -i -F -f "${tmp}/patterns" > "${tmp}/hits" 2>/dev/null; then :; fi
if [ -s "${tmp}/hits" ]; then
  echo "發現不該公開的字詞："
  cat "${tmp}/hits"
  exit 1
fi
echo "通過：${count} 個檔案沒有禁用字詞"
