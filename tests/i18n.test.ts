// 字串目錄的取字：t(key, params) 照句子裡 {name} 的位置填參數，少給參數丟錯；目錄沒有的鍵與參數名由型別檢查擋（claude plugin test）。
import { expect, test } from 'claude-code/testing'
import { t } from '../hooks/i18n'

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
