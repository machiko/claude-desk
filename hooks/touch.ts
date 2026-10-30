// 對話裡的哪些動作會讓面板過期：改了卡片或登錄表、跑了 /desk:card 的腳本、會移動分支的 git。
// 純函式；register.tsx 在工具呼叫結束後問它，要不要馬上重讀，不用等回合結束或定時更新。
import { parseCard, parseGate } from './card'

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

/** Bash 指令裡的 `card.py spec-ok <目標>`（目標可加引號）。 */
const SPEC_OK = /card\.py["']?\s+spec-ok\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|"']+))/g

/** 這次工具呼叫裡每一次 `card.py spec-ok <目標>` 的目標（slug、任務名或 main），照指令裡的順序；不是 Bash 或沒有就回空陣列。 */
export function specOkTargets(call: ToolTouch): string[] {
  if (call.tool !== 'Bash' || typeof call.command !== 'string') return []
  return [...call.command.matchAll(SPEC_OK)].map(m => (m[1] ?? m[2] ?? m[3] ?? '').trim()).filter(Boolean)
}

/** 這次工具呼叫是不是跑 /desk:card spec <目標> ok 的腳本：是就回（第一個）目標，其他回 null。 */
export function specOkTarget(call: ToolTouch): string | null {
  return specOkTargets(call)[0] ?? null
}

/**
 * 指令裡的 spec-ok 目標對不對得上這張卡：slug（worktree 資料夾名）完全相同，或任務名包含目標。
 * 刻意比 card.py 的 resolve 簡單（不認 main、不檢查唯一）：只用來縮小跑完要比對的卡，一個目標對到不只一張有變動的就當判斷不了。
 */
export function specOkMatches(target: string, c: { name: string; slug: string }): boolean {
  return !!target && (c.slug === target || c.name.includes(target))
}

/** card.py spec-ok 成功時印的那一行：`規格已確認（AC-1～AC-n），關卡清為「無」：<卡片路徑>`；失敗只印到 stderr、不動卡片。 */
const SPEC_OK_DONE = /^規格已確認（[^）\n]*），關卡清為「無」：(.+)$/gm

/**
 * 這次 Bash 呼叫確認了哪幾張卡：指令要跑 card.py spec-ok，而且輸出裡有腳本成功那一行；回傳那一行的卡片路徑。
 * 腳本失敗（例如關卡早就不是 spec）、指令只是提到它（echo、grep）都沒有那一行，回傳空陣列。
 */
export function specOkCards(call: ToolTouch, stdout: unknown): string[] {
  if (!specOkTarget(call) || typeof stdout !== 'string') return []
  return [...stdout.matchAll(SPEC_OK_DONE)].map(m => m[1]!.trim()).filter(Boolean)
}

/** card.py spec-ok 成功時在卡片寫的兩筆：History「<日期>：規格確認，關卡清為無，可派實作」、Decisions「D-n <日期> <人>：確認規格（…」。 */
const SPEC_OK_HISTORY = /^- \d{4}-\d{2}-\d{2}：規格確認，關卡清為無，可派實作\s*$/gm
const SPEC_OK_DECISION = /^- D-\d+ \d{4}-\d{2}-\d{2} [^\n]*?：確認規格（/gm

/** 卡片跟 spec-ok 有關的樣子：關卡是不是 spec、spec-ok 寫過的 History 與 Decisions 各幾筆。 */
export type SpecOkMarks = { isSpec: boolean; history: number; decisions: number }

/** 讀卡片全文算出 SpecOkMarks；沒有 DESK／CARD 區塊（不是卡片）回 null。 */
export function specOkMarks(text: string): SpecOkMarks | null {
  const card = parseCard(text)
  if (!card) return null
  const body = text.replace(/\r\n?/g, '\n')
  return { isSpec: parseGate(card['關卡'])?.kind === 'spec', history: body.match(SPEC_OK_HISTORY)?.length ?? 0, decisions: body.match(SPEC_OK_DECISION)?.length ?? 0 }
}

/**
 * 跑 card.py spec-ok 前後的同一張卡（成功那一行比指令裡 spec-ok 的次數少時，例如錯誤文字被截掉中間，只拿指令裡目標對得上的卡來比）：
 * confirmed：關卡從 spec 變成不是 spec，History 與 Decisions 也各多了 spec-ok 寫的那一筆；unchanged：關卡還是 spec，或沒有這次寫的那兩筆（腳本失敗、別的方式清掉關卡）；
 * unsure：前後有一邊讀不到，關卡又不是確定還在 spec，判斷不了。
 */
export function specOkVerdict(before: SpecOkMarks | null, after: SpecOkMarks | null): 'confirmed' | 'unchanged' | 'unsure' {
  if (after?.isSpec) return 'unchanged'
  if (!before || !after) return 'unsure'
  return before.isSpec && after.history > before.history && after.decisions > before.decisions ? 'confirmed' : 'unchanged'
}
