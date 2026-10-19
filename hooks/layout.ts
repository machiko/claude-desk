// 面板版面的純計算：自己換行（中文兩格寬）、按鈕排成幾列、捲動視窗落在哪幾列。
// 面板分 header／content／footer：header 與 footer 常駐，只有 content 捲動，所以 content 必須是一列一個元素、列數算得出來。
import { displayWidth } from './model'

/** 依顯示寬度換行：英數在空白處斷，中文逐字斷；保證每列不超過 width。 */
export function wrapText(text: string, width: number): string[] {
  const max = Math.max(4, width)
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    let used = 0
    for (const ch of Array.from(para)) {
      const w = displayWidth(ch)
      if (used + w > max) {
        const space = line.lastIndexOf(' ')
        // 斷在最近的空白（不要離行尾太遠），否則硬斷。
        if (space > 0 && displayWidth(line.slice(space)) <= 12) {
          out.push(line.slice(0, space))
          line = line.slice(space + 1)
          used = displayWidth(line)
        } else {
          out.push(line)
          line = ''
          used = 0
        }
      }
      line += ch
      used += w
    }
    out.push(line)
  }
  return out
}

/** 依序把寬度為 widths 的項目排進每列 width 格、項目間隔 gap；回傳每列的項目序號。 */
export function flowRows(widths: number[], width: number, gap = 2): number[][] {
  const rows: number[][] = []
  let row: number[] = []
  let used = 0
  widths.forEach((w, i) => {
    const need = row.length ? used + gap + w : w
    if (row.length && need > width) { rows.push(row); row = [i]; used = w }
    else { row.push(i); used = need }
  })
  if (row.length) rows.push(row)
  return rows
}

export type ContentWindow = { start: number; size: number; maxOffset: number; isScrolled: boolean }

/**
 * content 的視窗：bodyRows 扣掉 header 與 footer 是 content 能用的列數（至少 3）。
 * 放得下就整段顯示；放不下就從 offset 開始取一段，offset 夾在 0 到最後一頁之間。
 */
export function contentWindow(contentRows: number, bodyRows: number | undefined, chromeRows: number, offset: number): ContentWindow {
  if (!bodyRows || !Number.isFinite(bodyRows) || contentRows + chromeRows <= bodyRows) return { start: 0, size: contentRows, maxOffset: 0, isScrolled: false }
  const size = Math.max(3, bodyRows - chromeRows)
  const maxOffset = Math.max(0, contentRows - size)
  const start = Math.max(0, Math.min(maxOffset, Math.round(offset)))
  return { start, size: Math.min(size, contentRows), maxOffset, isScrolled: true }
}

/** footer 上的捲動位置：上面還有幾列、下面還有幾列。 */
export function scrollHint(w: ContentWindow, contentRows: number): string {
  if (!w.isScrolled) return ''
  const above = w.start
  const below = Math.max(0, contentRows - w.start - w.size)
  return [above ? `↑${above}` : '', below ? `↓${below}` : ''].filter(Boolean).join(' ')
}
