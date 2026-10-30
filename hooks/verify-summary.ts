// 完成檢查沒過時，從整份輸出整理出「幾支失敗、哪幾支、為什麼」給現在卡看；修正 Agent 的提示仍用輸出尾巴。
import type { CheckSummary } from '../types'

/** 認不出框架時列幾行尾巴（跟 Verify.tail 一樣多）。 */
const TAIL_LINES = 4
/** 最多記幾支失敗；總數照算在 failed。 */
const MAX_ITEMS = 50
/** 一列最多幾個字。 */
const MAX_ITEM_CHARS = 200
/** 往下找 Expected／Received 最多看幾行。 */
const DETAIL_LOOKAHEAD = 8

/** 只有 `-`、`=`、空白的分隔線（unittest、pytest 的 ----／==== 之類）。 */
export function isSeparator(line: string): boolean {
  return /^[-=\s]*$/.test(line)
}

type Parsed = { failed?: number; items: string[] }

/** 「名稱：原因」；照字（不是 UTF-16 單位）截，不會切出半個 emoji。 */
const item = (name: string, reason?: string) => Array.from(reason ? `${name}：${reason}` : name).slice(0, MAX_ITEM_CHARS).join('')

/** 從第 i+1 行起的第一行當原因；後面幾行有 Expected／Received（jest、plugin test 的 toBe）就接在括號裡。 */
function reasonAt(lines: string[], i: number, end: number): string | undefined {
  const body = lines.slice(i + 1, end).filter(l => !isSeparator(l))
  const first = body[0]?.trim()
  if (!first) return undefined
  const near = body.slice(1, DETAIL_LOOKAHEAD)
  const expected = near.map(l => l.match(/^\s*Expected:\s*(.*)$/)?.[1]).find(Boolean)
  const received = near.map(l => l.match(/^\s*Received:\s*(.*)$/)?.[1]).find(Boolean)
  return expected && received ? `${first}（Expected: ${expected}，Received: ${received}）` : first
}

/** 下一個符合 isHeader 的行（找不到就到結尾）。 */
function nextIndex(lines: string[], from: number, isHeader: (l: string) => boolean): number {
  const at = lines.findIndex((l, j) => j > from && isHeader(l))
  return at < 0 ? lines.length : at
}

/** unittest 的名稱行：`FAIL: test_x (模組.類別.test_x)`；後面一定接括號裡的點分名稱，`ERROR: config.yml not found` 這種一般錯誤行不算。 */
const UNITTEST_HEADER = /^(?:FAIL|ERROR): (\S+) \([\w.]+\)$/

/** Python unittest：`FAIL: test_x (…)`／`ERROR: …` 一段一支，原因是段內第一個沒縮排的 `…Error:`；總數看 `FAILED (failures=a, errors=b)`（不算 expected failures）。 */
function unittest(lines: string[]): Parsed | undefined {
  const isHeader = (l: string) => UNITTEST_HEADER.test(l) || /^Ran \d+ tests? in /.test(l)
  const items = lines.flatMap((l, i) => {
    const name = l.match(UNITTEST_HEADER)?.[1]
    if (!name) return []
    const section = lines.slice(i + 1, nextIndex(lines, i, isHeader)).filter(s => !isSeparator(s))
    return [item(name, section.find(s => /^[A-Za-z_][\w.]*(Error|Exception)\b/.test(s)) ?? section.at(-1))]
  })
  const counts = lines.map(l => l.match(/^FAILED \((.+)\)$/)?.[1]).find(Boolean)
  if (!items.length && !counts) return undefined
  const failed = counts ? counts.split(/,\s*/).reduce((n, kv) => n + Number(kv.match(/^(?:failures|errors)=(\d+)$/)?.[1] ?? 0), 0) : items.length
  return { failed, items }
}

/** pytest：short test summary 的 `FAILED path::name - 原因`／`ERROR …`；總數看 `=== n failed, m errors … ===`。 */
function pytest(lines: string[]): Parsed | undefined {
  const items = lines.flatMap(l => {
    const m = l.match(/^(?:FAILED|ERROR) (\S+::\S+)(?: - (.*))?$/)
    return m ? [item(m[1]!.split('::').at(-1)!, m[2])] : []
  })
  const counts = lines.find(l => /^=+ .*\b\d+ (failed|errors?)\b.* =+$/.test(l))
  if (!items.length && !counts) return undefined
  const failed = counts ? [...counts.matchAll(/\b(\d+) (?:failed|errors?)\b/g)].reduce((n, m) => n + Number(m[1]), 0) : items.length
  return { failed, items }
}

/**
 * claude plugin test：名稱行 `(fail) 名稱 [1.76ms]`，原因在下面縮排幾行；計數行 ` n fail`。
 * 2026-10-30 在 2.x 故意弄紅兩支看到的真實格式（沒有 ✕ 開頭）：
 *   (fail) first failing name [1.76ms]
 *     AssertionError: expect(received).toBe()
 *     Expected: 9
 *     Received: 12
 *    1 pass
 *    2 fail
 */
function pluginTest(lines: string[]): Parsed | undefined {
  const items = lines.flatMap((l, i) => {
    const name = l.match(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/)?.[1]
    if (!name) return []
    return [item(name, reasonAt(lines, i, nextIndex(lines, i, s => !/^\s/.test(s))))]
  })
  const counts = lines.map(l => l.match(/^\s*(\d+) fail$/)?.[1]).find(Boolean)
  if (!items.length && !counts) return undefined
  return { failed: counts ? Number(counts) : items.length, items }
}

/**
 * vitest／jest：名稱行 `× suite > name 3ms`／`✕ name (5 ms)`，原因在 `FAIL  file > … > name`／`● … › name` 底下；總數看 `Tests: n failed`。
 * 同名的測試照出現順序各配各的標題；jest 的名稱改用 `●` 標題上的完整路徑。
 */
function vitestJest(lines: string[]): Parsed | undefined {
  const isHeader = (l: string) => /^\s*(●|FAIL)\s/.test(l)
  const used = new Set<number>()
  const items = lines.flatMap(l => {
    const full = l.match(/^\s*[✕×] (.+?)(?:\s+\d+(?:\.\d+)?\s*ms|\s+\(\d+(?:\.\d+)?\s*m?s\))?$/)?.[1]
    if (!full) return []
    const at = lines.findIndex((h, j) => !used.has(j) && isHeader(h) && endsWithName(h.trimEnd(), full))
    if (at < 0) return [item(full)]
    used.add(at)
    const name = /^\s*●\s/.test(lines[at]!) ? lines[at]!.replace(/^\s*●\s+/, '').trimEnd() : full
    return [item(name, reasonAt(lines, at, nextIndex(lines, at, isHeader)))]
  })
  const counts = lines.map(l => l.match(/^\s*Tests:?\s+(\d+) failed\b/)?.[1]).find(Boolean)
  if (!items.length && !counts) return undefined
  return { failed: counts ? Number(counts) : items.length, items }
}

/** 標題以這個名稱結尾，而且前面是空白、`>` 或 `›`（`works` 不會配到 `networks`）。 */
const endsWithName = (header: string, name: string) => header.endsWith(name) && /[\s>›]/.test(header.at(-name.length - 1) ?? '')

/** 認不出框架：最後幾行，去掉分隔線。 */
function tailOf(lines: string[]): string[] {
  return lines.filter(l => !isSeparator(l)).slice(-TAIL_LINES)
}

/** 依序試 unittest、pytest、plugin test、vitest／jest；認得出框架但抓不到名稱時，計數照算、下面列尾巴並標 isTail。 */
export function summarizeCheck(lines: string[]): CheckSummary {
  const parsed = unittest(lines) ?? pytest(lines) ?? pluginTest(lines) ?? vitestJest(lines)
  if (!parsed) return { items: tailOf(lines) }
  if (!parsed.items.length) return { ...(parsed.failed !== undefined ? { failed: parsed.failed } : {}), items: tailOf(lines), isTail: true }
  return { ...(parsed.failed !== undefined ? { failed: parsed.failed } : {}), items: parsed.items.slice(0, MAX_ITEMS) }
}
