// 面板文字取字：t(key, params?) 從字串目錄取句子，{name} 換成 params 裡同名的值。
// 鍵與參數名都由目錄推出型別：目錄沒有的鍵、少給參數，型別檢查就不過；繞過型別少給參數時丟錯，不默默顯示空白。
// 語言目前固定 zh-TW（D-02：語言設定等英文那版才加），到時只換 CATALOG 的來源。
import { zhTW } from './zh-TW'

export type Catalog = typeof zhTW
export type CatalogKey = keyof Catalog

/** 句子裡 {name} 的參數名（型別層級，`as const` 的字面值才推得出來）。 */
type ParamNames<S extends string> = S extends `${string}{${infer P}}${infer R}` ? P | ParamNames<R> : never
export type ParamsOf<K extends CatalogKey> = Record<ParamNames<Catalog[K]>, string | number>
type ParamArgs<K extends CatalogKey> = [ParamNames<Catalog[K]>] extends [never] ? [] : [params: ParamsOf<K>]

const CATALOG: Readonly<Record<CatalogKey, string>> = zhTW
const PARAM = /\{(\w+)\}/g

/** 取目錄裡的句子並填入參數；鍵不在目錄或少給參數都丟錯（訊息寫給開發者看）。 */
export function t<K extends CatalogKey>(key: K, ...args: ParamArgs<K>): string {
  const text = CATALOG[key]
  if (typeof text !== 'string') throw new Error(`i18n: unknown key "${String(key)}"`)
  const params: Readonly<Record<string, string | number | undefined>> = args[0] ?? {}
  return text.replace(PARAM, (_whole, name: string) => {
    const value = params[name]
    if (value === undefined) throw new Error(`i18n: missing param "${name}" for key "${String(key)}"`)
    return String(value)
  })
}
