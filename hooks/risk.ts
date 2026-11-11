// 風險分級：看這個分支相對要併進去的分支（PR 目標、卡片基準欄、release 線、card.base 或 origin/HEAD，見 probes.ts 的 baseRefs）改了哪些檔。
// 低：只動文件 → 跳過審查。高：碰到下列任一處 → 審查過了還要加跑資安審查（設了 review.combineSecurity 就併進程式碼審查），最後停下來給你看。
// 這裡只放跨專案通用的路徑；專案自己的（例如授權核心類別）寫在 dispatch.json 的 risk.high。
import { t } from './i18n'

export type RiskLevel = 'low' | 'normal' | 'high'
export type Risk = { level: RiskLevel; reasons: string[] }

const LOW = [/\.md$/i, /^docs\//, /\.txt$/i]
export const HIGH: readonly [RegExp, string][] = [
  [/(^|\/)(Auth|Middleware)\//, t('risk.auth')],
  [/(^|\/)migrations?\//, 'migration'],
  [/^(bitbucket-pipelines\.yml|\.gitlab-ci\.yml|Jenkinsfile)$|^\.github\/workflows\//, 'CI'],
  [/(^|\/)Dockerfile[^/]*$|(^|\/)(docker-)?compose[^/]*\.ya?ml$/, t('pane.containers')],
  [/^(composer\.(json|lock)|package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?)$/, t('risk.deps')],
  [/(^|\/)\.env/, t('risk.env')],
]

/** 沒有檔案清單（讀不到 diff）算一般，不猜低風險。extra 是設定檔的專案路徑，排在內建的前面。 */
export function classify(files: readonly string[], extra: readonly [RegExp, string][] = []): Risk {
  const list = files.map(f => f.trim()).filter(Boolean)
  if (!list.length) return { level: 'normal', reasons: [] }
  const rules = [...extra, ...HIGH]
  const reasons = [...new Set(list.flatMap(f => rules.filter(([re]) => re.test(f)).map(([, why]) => why)))]
  if (reasons.length) return { level: 'high', reasons }
  if (list.every(f => LOW.some(re => re.test(f)))) return { level: 'low', reasons: [t('risk.docsOnly')] }
  return { level: 'normal', reasons: [] }
}
