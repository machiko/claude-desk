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

type Parsed = { failed: number; items: string[] }

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

/** pytest：short test summary 的 `FAILED path::name[參數 id] - 原因`／`ERROR …`（id 可以有空白與「 - 」）；總數看 `=== n failed, m errors … ===`。 */
function pytest(lines: string[]): Parsed {
  const items = lines.flatMap(l => {
    const m = l.match(/^(?:FAILED|ERROR) (\S+?::[^\s[]+(?:\[.*?\])?)(?: - (.*))?$/)
    return m ? [item(m[1]!.split('::').at(-1)!, m[2])] : []
  })
  const counts = lines.filter(l => /^=+ .*\b\d+ (failed|errors?)\b.* =+$/.test(l)).flatMap(l => [...l.matchAll(/\b(\d+) (?:failed|errors?)\b/g)].map(m => Number(m[1])))
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

/** vitest／jest 的失敗標題：`FAIL  file > … > name`（vitest）、`● … › name`（jest；`● Console` 是 console 輸出不是測試）。 */
const isFailHeader = (l: string) => /^\s*(●|FAIL)\s/.test(l) && !/^\s*● Console$/.test(l)

/** 標題拿來配名稱行的鍵：vitest 是檔名後面的完整路徑（跟 `×` 行一樣），jest 是最後一段（`✕` 行只有這段）；`FAIL file` 這種檔案標題沒有鍵。 */
function headerKey(header: string): string | undefined {
  const text = header.trim()
  if (text.startsWith('●')) return text.replace(/^●\s+/, '').split(' › ').at(-1)
  const at = text.indexOf(' > ')
  return at < 0 ? undefined : text.slice(at + 3)
}

/**
 * vitest／jest：名稱行 `× suite > name 3ms`／`✕ name (5 ms)`，原因在對應的標題底下；總數看 `Tests: n failed`。
 * 同名的測試照出現順序各配各的標題；jest 的名稱改用 `●` 標題上的完整路徑。
 * jest 一次跑兩個以上的檔時不印 `✕` 行（2026-10-30 用 jest 27.5 實跑），改用 `●` 標題當名稱。
 */
function vitestJest(lines: string[]): Parsed {
  const headers = lines.flatMap((l, i) => (isFailHeader(l) ? [i] : []))
  const after = (at: number) => headers.find(h => h > at) ?? lines.length
  const byKey = new Map<string, number[]>()
  for (const h of headers) {
    const key = headerKey(lines[h]!)
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), h])
  }
  const isJest = (at: number) => lines[at]!.trim().startsWith('●')
  const reason = (at: number) => reasonAt(lines, at, after(at))
  const fromJest = (at: number) => item(lines[at]!.trim().replace(/^●\s+/, ''), reason(at))
  const items: string[] = []
  for (const l of lines) {
    if (items.length >= MAX_ITEMS) break
    const full = l.match(/^\s*[✕×] (.+?)(?:\s+\d+(?:\.\d+)?\s*ms|\s+\(\d+(?:\.\d+)?\s*m?s\))?$/)?.[1]
    if (!full) continue
    const at = byKey.get(full)?.shift()
    items.push(at === undefined ? item(full) : isJest(at) ? fromJest(at) : item(full, reason(at)))
  }
  if (!items.length) items.push(...headers.filter(isJest).slice(0, MAX_ITEMS).map(fromJest))
  const counts = lines.flatMap(l => l.match(/^\s*Tests:?\s+(\d+) failed\b/)?.[1] ?? []).map(Number)
  return { failed: total(counts, items), items }
}

/** 認不出框架：最後幾行，去掉分隔線。 */
function tailOf(lines: string[]): string[] {
  return lines.filter(l => !isSeparator(l)).slice(-TAIL_LINES)
}

const PARSERS = [unittest, pytest, pluginTest, vitestJest]

/** 照順序試，試到說得出有失敗的就停（後面的解析器不用跑）。 */
function firstFailing(lines: string[]): Parsed | undefined {
  for (const parse of PARSERS) {
    const parsed = parse(lines)
    if (parsed.failed > 0) return parsed
  }
  return undefined
}

/**
 * 依序試 unittest、pytest、plugin test、vitest／jest，第一個說得出有幾支失敗的算數；失敗數是 0（例如 plugin test 通過、後面串的指令沒過）就當認不出。
 * 認得出框架但抓不到名稱時，計數照算、下面列尾巴並標 isTail。
 */
export function summarizeCheck(lines: string[]): CheckSummary {
  const parsed = firstFailing(lines)
  if (!parsed) return { items: tailOf(lines) }
  if (!parsed.items.length) return { failed: parsed.failed, items: tailOf(lines), isTail: true }
  return { failed: parsed.failed, items: parsed.items.slice(0, MAX_ITEMS) }
}
