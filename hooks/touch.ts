// 對話裡的哪些動作會讓面板過期：改了卡片或登錄表、跑了 /desk:card 的腳本、會移動分支的 git。
// 純函式；register.tsx 在工具呼叫結束後問它，要不要馬上重讀，不用等回合結束或定時更新。

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const CARD_FILE = /(^|\/)(\.desk\/CARD\.md|\.console\/STATUS\.md)$/
/** Bash 指令裡出現這些就重讀：卡片腳本、卡片與登錄表檔名。 */
const CARD_TOUCH = /card\.py|\.desk\/CARD\.md|\.console\/STATUS\.md|projects-scope\.md/
/** git 子指令前的選項：-C <路徑>（可加引號）、-c k=v、--git-dir=…、--no-pager 等。 */
const GIT_OPTS = String.raw`(?:\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|-c\s+\S+|--?[\w-]+(?:=\S+)?))*`
/** 會改 HEAD、tag、暫存區或遠端分支的 git 子指令。 */
const GIT_TOUCH = new RegExp(String.raw`\bgit\b${GIT_OPTS}\s+(?:commit|merge|rebase|reset|checkout|switch|tag|cherry-pick|revert|pull|push|fetch|stash|add|worktree)\b`)
/** 會改 PR 狀態的 gh 指令。 */
const GH_TOUCH = /\bgh\s+pr\s+(?:create|merge|close|reopen|ready)\b/

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

export type ToolTouch = { tool: string; file_path?: unknown; notebook_path?: unknown; command?: unknown }

/**
 * 這次工具呼叫會不會讓面板看到的東西過期。`known` 是登錄表與每張卡片的路徑（登錄表可以不叫 projects-scope.md）。
 */
export function touchesDesk(call: ToolTouch, known: readonly string[]): boolean {
  const paths = new Set(known.filter(Boolean).map(norm))
  if (EDIT_TOOLS.has(call.tool)) {
    const raw = typeof call.file_path === 'string' ? call.file_path : typeof call.notebook_path === 'string' ? call.notebook_path : ''
    const file = norm(raw)
    return !!file && (paths.has(file) || CARD_FILE.test(file))
  }
  if (call.tool === 'Bash' && typeof call.command === 'string') {
    const cmd = call.command
    return CARD_TOUCH.test(cmd) || GIT_TOUCH.test(cmd) || GH_TOUCH.test(cmd) || [...paths].some(p => cmd.includes(p))
  }
  return false
}
