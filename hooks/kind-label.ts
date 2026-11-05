// 派工種類的中文名。獨立成檔、不 import 任何模組：actions.ts 載入時就要讀它，
// 放在 dispatch.ts 會跟 dispatch → turn → actions 形成循環，載入順序不對時讀到未初始化的值。
import type { DispatchKind } from './dispatch'

export const KIND_LABEL: Record<DispatchKind, string> = { continue: '繼續', sync: '同步', review: '驗收', reply: '回覆', publish: '推送', catchup: '解衝突' }
