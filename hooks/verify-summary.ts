// 完成檢查沒過時，從整份輸出整理出「幾支失敗、哪幾支、為什麼」給現在卡看；修正 Agent 的提示仍用輸出尾巴。
// 只認這個專案用的兩種輸出（Python unittest、claude plugin test）；其他框架走通用規則，不保證抓到測試名（D-06）。
import type { CheckSummary } from '../types'

/** 認不出框架時列幾行（跟 Verify.tail 一樣多）。 */
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

type Parsed = { failed: number; items: string[] }

/** 「名稱：原因」；照字（不是 UTF-16 單位）截，不會切出半個 emoji。 */
const item = (name: string, reason?: string) => Array.from(reason ? `${name}：${reason}` : name).slice(0, MAX_ITEM_CHARS).join('')

/** 從第 i+1 行起的第一行當原因；後面幾行有 Expected／Received（plugin test 的 toBe）就接在括號裡。 */
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
  for (let j = from + 1; j < lines.length; j++) if (isHeader(lines[j]!)) return j
  return lines.length
}

/** 每一段的計數加起來（`a && b` 串了好幾段測試時各段都有計數行）；沒有計數或加起來是 0 就用抓到的支數。 */
function total(counts: number[], items: string[]): number {
  const sum = counts.reduce((n, c) => n + c, 0)
  return sum > 0 ? sum : items.length
}

/**
 * unittest 的名稱行：`FAIL: test_x (模組.類別.test_x)`，subTest 依序再接訊息 `[m]` 與參數 `(i=1)`；
 * 後面一定接括號裡的點分名稱，`ERROR: config.yml not found` 這種一般錯誤行不算。
 */
const UNITTEST_HEADER = /^(?:FAIL|ERROR): (\S+) \(([\w.]+)\)((?: \[.*\])?(?: \(.*\))?)$/
/** 類別或模組層級的準備／收尾壞掉時，名稱行沒有測試名，補上括號裡的類別或模組。 */
const FIXTURE_NAMES = new Set(['setUpClass', 'tearDownClass', 'setUpModule', 'tearDownModule'])

/** Python unittest：`FAIL: test_x (…)`／`ERROR: …` 一段一支，原因是段內第一個沒縮排的 `…Error:`；總數看 `FAILED (failures=a, errors=b)`（不算 expected failures）。 */
function unittest(lines: string[]): Parsed {
  const isHeader = (l: string) => UNITTEST_HEADER.test(l) || /^UNEXPECTED SUCCESS: /.test(l) || /^Ran \d+ tests? in /.test(l)
  const items = lines.flatMap((l, i) => {
    const m = l.match(UNITTEST_HEADER)
    if (!m) return []
    const name = FIXTURE_NAMES.has(m[1]!) ? `${m[1]} (${m[2]})` : m[1]! + m[3]!
    const section = lines.slice(i + 1, nextIndex(lines, i, isHeader)).filter(s => !isSeparator(s))
    return [item(name, section.find(s => /^[A-Za-z_][\w.]*(Error|Exception)\b/.test(s)) ?? section.at(-1))]
  })
  const counts = lines.flatMap(l => l.match(/^FAILED \((.+)\)$/)?.[1].split(/,\s*/) ?? []).map(kv => Number(kv.match(/^(?:failures|errors)=(\d+)$/)?.[1] ?? 0))
  return { failed: total(counts, items), items }
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
 * 測試檔載入失敗時名稱固定是 `(fail) the file did not load`，改用上面 `tests/x.test.ts:` 那行的檔名。
 */
function pluginTest(lines: string[]): Parsed {
  const items: string[] = []
  let file: string | undefined
  for (let i = 0; i < lines.length && items.length < MAX_ITEMS; i++) {
    file = lines[i]!.match(/^(\S+\.test\.[jt]sx?):$/)?.[1] ?? file
    const name = lines[i]!.match(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/)?.[1]
    if (!name) continue
    items.push(item(name === 'the file did not load' && file ? `${file} did not load` : name, reasonAt(lines, i, nextIndex(lines, i, s => !/^\s/.test(s)))))
  }
  const counts = lines.flatMap(l => l.match(/^\s*(\d+) fail$/)?.[1] ?? []).map(Number)
  return { failed: total(counts, items), items }
}

/** 通用規則認「像是在講失敗」的行：fail／failed／failures、error／errors、exception，含 …Error／…Exception 結尾的類別名（不分大小寫）。 */
const ERROR_LINE = /fail(?:ed|ures?)?\b|errors?\b|exceptions?\b/i
/** 「0 fail」「0 errors」這種說沒有失敗的字樣不算；拿掉之後還有失敗字樣的行才是。 */
const ZERO_COUNT = /\b0 (?:fail(?:ed|ures?)?|errors?|exceptions?)\b/gi
const isErrorLine = (line: string) => ERROR_LINE.test(line.replace(ZERO_COUNT, ''))

/**
 * 認不出框架：列含 FAIL／ERROR／Error 這類字的行（pytest 的 `FAILED path::name - 原因`、vitest 的 `FAIL file > name` 與 `AssertionError: …`
 * 都會被抓到），最多最後幾行；一行都沒有就列去掉分隔線的尾巴。不算支數、不保證是測試名。
 */
function tailOf(lines: string[]): string[] {
  const kept = lines.filter(l => !isSeparator(l))
  const hits = kept.filter(isErrorLine)
  return (hits.length ? hits : kept).slice(-TAIL_LINES)
}

const PARSERS = [unittest, pluginTest]

/** 照順序試，試到說得出有失敗的就停（後面的解析器不用跑）。 */
function firstFailing(lines: string[]): Parsed | undefined {
  for (const parse of PARSERS) {
    const parsed = parse(lines)
    if (parsed.failed > 0) return parsed
  }
  return undefined
}

/**
 * 依序試 unittest、plugin test，第一個說得出有幾支失敗的算數；失敗數是 0（例如 plugin test 通過、後面串的指令沒過）就當認不出，走通用規則。
 * 認得出框架但抓不到名稱時，計數照算、下面列通用規則的行並標 isTail。
 */
export function summarizeCheck(lines: string[]): CheckSummary {
  const parsed = firstFailing(lines)
  if (!parsed) return { items: tailOf(lines) }
  if (!parsed.items.length) return { failed: parsed.failed, items: tailOf(lines), isTail: true }
  return { failed: parsed.failed, items: parsed.items.slice(0, MAX_ITEMS) }
}
