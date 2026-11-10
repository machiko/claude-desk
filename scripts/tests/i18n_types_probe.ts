// t() 的型別探針：scripts/tests/test_i18n_types.py 用 tsc 編這個檔，零錯誤才算過。
// 正確寫法要過；每個 @ts-expect-error 底下那行一定要是型別錯誤，否則 tsc 報「Unused '@ts-expect-error'」，簽名被改鬆就會紅。
import { t } from '../../hooks/i18n'

// 正確寫法：沒有參數的句子不帶參數；有參數的句子給齊（順序不拘、數字也可以）。
export const ok: string[] = [
  t('update.busy'),
  t('stack.waitWhy', { name: '訂單匯出' }),
  t('update.folderOffBranch', { current: 'feature/x', branch: 'main', dir: '/w/desk' }),
  t('formats.newerRegistry', { path: '/w/registry.md', format: 2 }),
]

export const wrong: string[] = [
  // @ts-expect-error 目錄沒有的鍵
  t('update.noSuchKey'),
  // @ts-expect-error 少給一個參數（current）
  t('update.folderOffBranch', { dir: '/w/desk', branch: 'main' }),
  // @ts-expect-error 有參數的句子整個沒給參數
  t('stack.waitWhy'),
  // @ts-expect-error 參數名打錯（nmae）
  t('stack.waitWhy', { nmae: '訂單匯出' }),
  // @ts-expect-error 沒有參數的句子卻帶了參數
  t('update.busy', { name: 'x' }),
  // @ts-expect-error 鍵不是字面值（任意字串）
  t(String('stack.waitWhy'), { name: 'x' }),
]
