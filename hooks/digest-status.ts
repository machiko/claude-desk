// 狀態摘要：面板只放一句短話。先用規則（第一句、去括號、去 hash 與時間）立刻給一句，
// 再請 haiku 濃縮成 20 字內的一句，依原文快取。純函式在這裡，呼叫在 register.tsx。
import { displayWidth, fit, plain } from './model'
import { splitClauses } from './card'

export const SUMMARY_MAX = 40

/** 規則精簡：第一句；拿掉全形與半形括號裡的細節、7 碼以上的 hash、日期時間、孤立的 @。 */
export function compactStatus(text: string, max = SUMMARY_MAX): string {
  const first = splitClauses(plain(text))[0] ?? ''
  const cleaned = first
    .replace(/（[^（）]*）|\([^()]*\)/g, ' ')
    .replace(/(?<![0-9A-Za-z])[0-9a-f]{7,40}(?![0-9A-Za-z])/g, ' ')
    .replace(/(?<![\d#.])\d{4}-\d{1,2}-\d{1,2}(?!\d)|(?<![\d#.])\d{1,2}-\d{1,2}(?!\d)/g, ' ')
    .replace(/(?<!\d)\d{1,2}:\d{2}(?!\d)/g, ' ')
    .replace(/\s*@\s*/g, ' ')
    .replace(/\s*([＝，、；：。])\s*/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s，,；;：:＝=。]+|[\s，,；;：:＝=]+$/g, '')
    .trim()
  return fit(cleaned || first, max)
}

export const SUMMARY_SYSTEM = '你把軟體開發任務的狀態濃縮成一句繁體中文（台灣用語），20 個字以內。只留結論與還沒做的事；不要 commit hash、時間、括號細節、測試數字。只輸出那一句，不要引號、不要句號以外的標點。'

export const summaryPrompt = (status: string) => `狀態原文：\n${plain(status)}`

/** 模型回覆清成一句：第一行、去引號與結尾句號、去控制字元，超長就截。 */
export function cleanSummary(reply: string, max = 40): string {
  const line = plain(reply).split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? ''
  const s = line.replace(/^[「『"'“]+|[」』"'”]+$/g, '').replace(/[。.]+$/, '').trim()
  return displayWidth(s) > max ? fit(s, max) : s
}

/** 快取的鍵：原文的簡單雜湊（djb2）。 */
export function textKey(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
