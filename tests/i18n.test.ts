// 字串目錄的取字：t(key, params) 照句子裡 {name} 的位置填參數，少給參數丟錯；目錄沒有的鍵與參數名由型別檢查擋（claude plugin test 不做型別檢查，由 scripts/tests/test_i18n_types.py 跑 tsc）。
import { expect, test } from 'claude-code/testing'
import { t } from '../hooks/i18n'
import type { CatalogKey } from '../hooks/i18n'
import { zhTW } from '../hooks/i18n/zh-TW'

/** i18n 目錄與示範 AC-2：具名參數填進句中對應位置，同一個參數出現兩次兩處都填；沒有參數的句子原樣回傳。 */
test('test_t_fills_named_params_in_order', () => {
  expect(t('update.folderOffBranch', { dir: '/w/desk', branch: 'main', current: 'feature/x' }))
    .toBe('本機資料夾 /w/desk 不在預設分支 main（目前 feature/x），請先切回 main 再更新')
  expect(t('formats.newerRegistry', { format: 2, path: '/w/registry.md' }))
    .toBe('登錄表 /w/registry.md 是較新版 desk 的格式（格式 2），請更新 desk')
  expect(t('stack.waitWhy', { name: '訂單匯出' })).toBe('等原卡「訂單匯出」合併')
  expect(t('update.busy')).toBe('desk 正在更新中，請稍候。')
})

/** i18n 目錄與示範 AC-2：少給參數（繞過型別）丟錯並說出缺哪個，不默默顯示成空白；目錄沒有的鍵型別檢查不過、執行時也丟錯。 */
test('test_t_reports_missing_param', () => {
  // @ts-expect-error 少給 current：型別檢查就擋下
  expect(() => t('update.folderOffBranch', { dir: '/w/desk', branch: 'main' })).toThrow('missing param "current"')
  // @ts-expect-error 有參數的句子沒給參數
  expect(() => t('stack.waitWhy')).toThrow('missing param "name"')
  // @ts-expect-error 目錄沒有這個鍵
  expect(() => t('update.noSuchKey')).toThrow('unknown key "update.noSuchKey"')
})

/**
 * 同一個字的鍵與例外：值一樣、鍵不同的幾組，要嘛併成共用段（word.*、state.*、time.*）的一個鍵，要嘛列在這裡寫原因。
 * 鍵用來讀，不刪成一份就是兩處各改各的、英文版也要翻兩次。
 */
const SHARED_WORD_EXCEPTIONS: readonly { keys: readonly CatalogKey[]; why: string }[] = []

/** 目錄裡值相同、鍵不同的幾組（每組的鍵依字母排），扣掉 exceptions 列的。 */
function duplicateEntries(catalog: Readonly<Record<string, string>>, exceptions: readonly { keys: readonly string[] }[] = []): string[][] {
  const byText = new Map<string, string[]>()
  for (const [key, text] of Object.entries(catalog)) byText.set(text, [...(byText.get(text) ?? []), key])
  const allowed = new Set(exceptions.map(e => [...e.keys].sort().join(' ')))
  return [...byText.values()].filter(keys => keys.length > 1).map(keys => [...keys].sort()).filter(keys => !allowed.has(keys.join(' ')))
}

/** i18n 外框 AC-3：共用字彙在目錄裡只有一份（值重複且鍵不同就列出）；例外清單每組都寫原因，而且真的還是重複的。 */
test('test_shared_words_have_single_entry', () => {
  expect(duplicateEntries(zhTW, SHARED_WORD_EXCEPTIONS)).toEqual([])
  for (const e of SHARED_WORD_EXCEPTIONS) {
    expect([e.keys, e.why.trim().length > 0]).toEqual([e.keys, true])
    expect([e.keys, new Set(e.keys.map(k => zhTW[k])).size]).toEqual([e.keys, 1])
  }
  // 守門本身：同值不同鍵會被列出，列進例外的那組不算。
  const sample = { 'word.wait': '等你', 'band.wait': '等你', 'state.ask': '等你', 'time.today': '今天' }
  expect(duplicateEntries(sample)).toEqual([['band.wait', 'state.ask', 'word.wait']])
  expect(duplicateEntries(sample, [{ keys: ['word.wait', 'state.ask', 'band.wait'] }])).toEqual([])
})
