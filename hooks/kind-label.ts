// 派工種類的中文名（字串目錄的 kindLabel.*）。獨立成檔、只 import 字串目錄（它不 import 別的模組）：actions.ts 載入時就要讀它，
// 放在 dispatch.ts 會跟 dispatch → turn → actions 形成循環，載入順序不對時讀到未初始化的值。
import type { DispatchKind } from './dispatch'
import { t } from './i18n'

export const KIND_LABEL: Record<DispatchKind, string> = {
  continue: t('kindLabel.continue'),
  sync: t('kindLabel.sync'),
  review: t('kindLabel.review'),
  reply: t('kindLabel.reply'),
  publish: t('kindLabel.publish'),
  catchup: t('kindLabel.catchup'),
}
