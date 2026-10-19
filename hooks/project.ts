// 目前專案：用 git common dir 認 repo（worktree 跟主 repo 算同一個），每個專案的登錄表與設定放在
// ~/.claude/handoffs/<專案鍵>/。純函式；跑 git 的部分在 probes.ts。

/** 每個專案資料夾裡的檔名。 */
export const PROJECT_FILES = { registry: 'projects-scope.md', settings: 'dispatch.json', pitfalls: 'review-pitfalls.md', reviews: 'reviews' } as const
export const HANDOFFS = '~/.claude/handoffs'

export type Project = { key: string; dir: string }

/**
 * git common dir → 專案鍵：一般 repo 取 `.git` 上一層的資料夾名；bare repo 取資料夾名並去掉 `.git` 字尾；
 * 點開頭的（`.bare` 這類放 bare repo 的隱藏資料夾）也取上一層。中文與空白都可以，只擋路徑分隔與控制字元。
 * skills/card/scripts/card.py 的 project_key 是同一套規則。
 */
export function projectKey(commonDir: string): string {
  const parts = commonDir.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean)
  const last = parts.pop() ?? ''
  const name = last.startsWith('.') ? parts.pop() ?? '' : last.replace(/\.git$/, '')
  return name && !name.startsWith('.') && !/[\u0000-\u001f]/.test(name) ? name : ''
}

/** `git rev-parse --path-format=absolute --git-common-dir` 的輸出 → 專案；不是 git 或認不出名字就 null。 */
export function projectOf(stdout: string | null, home: string): Project | null {
  const key = projectKey((stdout ?? '').trim().split(/\r?\n/)[0] ?? '')
  return key ? { key, dir: `${home}/.claude/handoffs/${key}` } : null
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** 全域 dispatch.json 疊上專案的：專案檔有的頂層鍵整個取代全域的同名鍵。兩份都沒有就 null；壞掉的一份當作沒有。 */
export function mergeSettingsText(globalText: string | null, projectText: string | null): string | null {
  const parse = (t: string | null) => { if (!t) return null; try { const d = JSON.parse(t.replace(/^﻿/, '')); return isObject(d) ? d : null } catch { return null } }
  const g = parse(globalText)
  const p = parse(projectText)
  if (!g && !p) return null
  return JSON.stringify({ ...(g ?? {}), ...(p ?? {}) })
}
