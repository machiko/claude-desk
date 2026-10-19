// 風險分級：看這個分支相對 release 線改了哪些檔。
// 低：只動文件 → 跳過審查。高：碰到下列任一處 → 審查過了還要加跑資安審查，最後停下來給你看。
// 這裡只放跨專案通用的路徑；專案自己的（例如授權核心類別）寫在 dispatch.json 的 risk.high。
export type RiskLevel = 'low' | 'normal' | 'high'
export type Risk = { level: RiskLevel; reasons: string[] }

const LOW = [/\.md$/i, /^docs\//, /\.txt$/i]
export const HIGH: readonly [RegExp, string][] = [
  [/(^|\/)(Auth|Middleware)\//, '認證／中介層'],
  [/(^|\/)migrations?\//, 'migration'],
  [/^(bitbucket-pipelines\.yml|\.gitlab-ci\.yml|Jenkinsfile)$|^\.github\/workflows\//, 'CI'],
  [/(^|\/)Dockerfile[^/]*$|(^|\/)(docker-)?compose[^/]*\.ya?ml$/, '容器'],
  [/^(composer\.(json|lock)|package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?)$/, '相依套件'],
  [/(^|\/)\.env/, '環境設定'],
]

/** 沒有檔案清單（讀不到 diff）算一般，不猜低風險。extra 是設定檔的專案路徑，排在內建的前面。 */
export function classify(files: readonly string[], extra: readonly [RegExp, string][] = []): Risk {
  const list = files.map(f => f.trim()).filter(Boolean)
  if (!list.length) return { level: 'normal', reasons: [] }
  const rules = [...extra, ...HIGH]
  const reasons = [...new Set(list.flatMap(f => rules.filter(([re]) => re.test(f)).map(([, why]) => why)))]
  if (reasons.length) return { level: 'high', reasons }
  if (list.every(f => LOW.some(re => re.test(f)))) return { level: 'low', reasons: ['只動文件'] }
  return { level: 'normal', reasons: [] }
}
