/** 一個決策：題目與可按的選項（`A) …` 或 `1) …`）。 */
export type DecisionOption = { key: string; text: string }
export type Decision = { title: string; options: DecisionOption[] }

/** 關卡：只有三種，其他寫法視為無法讀。 */
export type Gate = { kind: 'spec' | 'review' | 'release' | 'unknown'; detail: string }

/** 工作桌自己跑過的驗證結果，按卡片路徑記住。 */
export type Verify = { command: string; at: number; ok: boolean; exitCode: number; tail: string[]; truncated: boolean; /** 跑的時候分支的 HEAD；之後有新 commit 這次檢查就不算數。 */ head?: string }

/** 一件任務的狀態詞：等你 > 回覆／批准權限 > 關卡 > 進行 > 失敗 > 可做 > 閒置 > 無卡。 */
export type CaseState = 'ask' | 'reply' | 'approve' | 'gate' | 'running' | 'failed' | 'ready' | 'done' | 'idle' | 'nocard'

/** 任務根目錄裡跑著的背景 agent（`claude agents --json --all`）。 */
export type AgentInfo = { id?: string; name: string; sessionId?: string; state: string; status: string; waitingFor?: string; startedAt?: number; /** `claude logs` 的最後一句，進行中才讀。 */ last?: string; /** 這是工作桌派出去、做完後停在提問的那一次。 */ asks?: boolean; /** 停下來在等什麼：權限提示（waitingFor 提到 permission）或提問；沒停下來就沒有。 */ waitsFor?: 'permission' | 'question'; /** 工作桌派的那一次是什麼工作（對得上最後一次派工才有）。 */ kind?: ChainInfo['lastKind'] }

export type StageId = 'spec' | 'build' | 'check' | 'review' | 'merge' | 'ship'
/** done 過了・active 有人在做・wait 等你或等下一步・fail 卡住・todo 還沒到・na 這件任務不適用 */
export type StageStatus = 'done' | 'active' | 'wait' | 'fail' | 'todo' | 'na'
export type Stage = { id: StageId; label: string; status: StageStatus }
export type Pipeline = { stages: Stage[]; current: StageId | null; note: string }
export type ReviewVerdict = { critical: number; high: number; medium: number; low: number }
/** 這個分支的 PR（Bitbucket 或 GitHub）：狀態與 CI。 */
export type PrInfo = { id: number; state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED'; ci: 'none' | 'pending' | 'pass' | 'fail'; dest?: string; url?: string; /** PR 最後的 head commit（GitHub 40 碼、Bitbucket 12 碼）；合併後比對 HEAD 看分支上有沒有新 commit。 */ head?: string }
/** 自動流程在這件任務的狀況，畫圖用。 */
export type ChainInfo = { round: number; stopped?: string; passed?: boolean; needsHuman?: string; skippedReview?: boolean; /** 審查（或免審查過關）之後分支有新 commit：那次的結論不算數。 */ stale?: boolean; /** 卡片上的審查結論不是 desk 派的審查判的（例如實作的 Agent 自己寫的）。 */ selfReview?: boolean; lastKind?: 'continue' | 'sync' | 'review' | 'reply' | 'fix' | 'verify' | 'publish'; /** 這個對話的流程還沒處理剛做完的實作：檢查通過後會自動派審查，不用你按 w。 */ autoReview?: boolean; /** 停在檢查段（指令未核准、容器沒啟動、檢查中斷）：排除後按 v，流程接著走。 */ heldAtCheck?: boolean; /** 流程是別的對話開的：這個對話不接手，按 v 只跑檢查。 */ foreign?: boolean }

export type Case = {
  name: string
  statusPath: string
  root: string
  hasCard: boolean
  /** 登錄表 Executor 欄寫 manual：只追蹤，不派工。 */
  manual?: boolean
  status: string
  verify: string
  ask: string
  next: string
  gate: string
  /** 卡片檔案最後寫入時間；讀不到為 null。 */
  updatedAt: number | null
  /** 分支最後一次 commit 的時間（毫秒；不算只改卡片的 commit）；讀不到或教學模式就沒有。 */
  commitAt?: number
  /** 那次 commit 改到的檔案最後被修改的時間（不晚於 commit）：先寫卡、測試跑很久才 commit 時，程式其實比卡片早改好。 */
  changedAt?: number
  agent?: AgentInfo
  state: CaseState
  git?: { branch: string; head: string }
  pr?: PrInfo
  /** git 看到分支 HEAD 已經在這個分支裡（例如 origin/main）；只在合併段才查。 */
  mergedInto?: string
  /** 示範任務（教學模式的背景）：只能看，沒有動作、不會寫入。 */
  demo?: boolean
  /** 包含目前 HEAD 的 v* tag（最舊的那個）。 */
  tag?: string
  chain?: ChainInfo
  pipeline?: Pipeline
  /** 狀態的一句摘要（haiku 濃縮，或規則精簡）。 */
  statusShort?: string
  /** git status：領先、落後、未提交、未追蹤。 */
  gitState?: { ahead: number; behind: number; changed: number; untracked: number; upstream?: boolean }
  /** 卡片有「## 規格」段，卻認不到填好的驗收情境（AC-n）：停在規格段、不能派實作。沒有規格段的舊卡不算。 */
  specGap?: true
  /** 卡片「## 部署…」段落的步驟。 */
  deploySteps?: string[]
  /** 審查檔的 CRITICAL、HIGH 前三條。 */
  reviewTop?: string[]
}

/** footer 版本格的四種狀態。 */
export type VersionState = 'newer' | 'latest' | 'unknown' | 'updating'

export type Snapshot = {
  at: number
  cases: Case[]
  error: string | null
  contextPercent: number | null
  demo?: boolean
  /** 教學模式：只顯示沙盒裡的那一件，Agent 與審查由腳本扮演。 */
  tutorial?: boolean
  /** 目前專案（repo 資料夾名）；面板只列這個專案登錄表裡的任務。 */
  project?: string
  /** 專案預設位置的登錄表讀不到：面板提供「建立空的登錄表」，寫到這個路徑。registryPath 指定的不算。 */
  missingRegistry?: string
  /** 使用額度：five_hour、seven_day 的剩餘百分比與重置時間。 */
  limits?: { kind: string; remaining: number; resetsAt?: string }[]
  /** desk 本身的版本；產品線上版（最新 v* tag）與開發中版本（release/* 分支）。 */
  versions?: { desk?: string; live?: string; dev?: string }
  /** 自動檢查查到 GitHub 上有比已安裝更新的 desk：面板與摘要列顯示「有新版本 <latest>」。 */
  update?: { latest: string }
  /** desk 版本的狀況：newer 有新版、latest 已是最新、unknown 沒查過（或檢查關閉、上次沒查成功）、updating 正在更新；footer 的版本格依它畫。沒有＝unknown。 */
  versionState?: VersionState
  /** 這個對話的模型與 effort（最近一次請求）；派工與同步用的模型與 effort（dispatch.json）。 */
  /** 登錄表「## 提醒」：日期、事項、距今天數。 */
  reminders?: { date: string; text: string; days: number }[]
  /** 主工作區的容器（docker compose ps）。 */
  containers?: { total: number; running: number; down: string[]; unhealthy: string[]; error?: string }
  models?: { session?: string; effort?: string; dispatch?: { model: string; effort: string }; sync?: { model: string; effort: string; fresh: boolean }; /** dispatch.json 的 kinds：跟派工不同的種類才列。 */ kinds?: { kind: 'continue' | 'reply' | 'review' | 'publish'; model: string; effort: string }[]; /** 有 projects 覆寫的任務（鍵是根目錄）：每種派工實際會用的模型。 */ byRoot?: Record<string, Partial<Record<'continue' | 'reply' | 'review' | 'publish', { model: string; effort: string }>>> }
}

/** 一筆動態；card：屬於哪件（卡片路徑），版本更新這類不屬於任何一件的不填。 */
export type FeedEvent = { at: number; text: string; tone: 'warning' | 'success' | 'error' | 'subtle' | 'suggestion'; card?: string }

/** 決策的選擇：`任務路徑\n等你全文` → 決策序號 → 選項鍵。等你改寫就作廢。 */
export type Picks = Record<string, Record<string, string>>

/**
 * 從面板填入、送出的決策。ask：送出當下卡片「等你」的原文（等你改了就失效）；during：送出時正在跑的回合；
 * by：送出之後才開始的回合（排隊的提示由它處理）；done：處理它的回合結束了，卡片卻沒寫回。
 */
export type SentRecord = { ask: string; during?: string; by?: string; done?: boolean }

/** 你在面板做、會改變任務狀態的一個操作（成功或失敗）：等下一則你打的提示附給對話。name：哪件任務，建立登錄表、更新版本這類不屬於任何一件的不填。 */
export type PanelAction = { at: number; name?: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    desk: {
      snapshot: Snapshot | null
      isPaneOpen: boolean
      isBandHidden: boolean
      /** 被選取的任務（卡片路徑）：對話的主角，每次送出提示都附上它的卡；取消選取在「更多動作」裡。 */
      selected: string | null
      /** 從面板送出的決策：卡片路徑 → 送出時的「等你」原文與由哪個回合處理；等你改了就失效。 */
      sent: Record<string, SentRecord>
      /** 你在面板做了、對話還不知道的操作（依時間順序，最多 20 筆）：下一則你打的提示附上後清掉。 */
      panelActions: PanelAction[]
      feed: FeedEvent[]
      picks: Picks
      verifies: Record<string, Verify>
      /** 正在跑驗證的任務：卡片路徑 → 開始時間。 */
      verifying: Record<string, number>
      /** 讓進行中的旋轉符號重繪用的計數。 */
      tick: number
      /** 是否展開「狀態」全文與驗證輸出。 */
      isExpanded: boolean
      /** 正在派工的任務：卡片路徑 → 開始時間；清單還沒看到 agent 前先擋第二次。 */
      launching: Record<string, number>
      /** 排隊等著跑完成檢查的任務（卡片路徑），依序。 */
      checkQueue: string[]
      /** 派工與停止要按兩次：第一次按下記在這裡，3 秒內再按同一個才執行。 */
      armed: { key: string; at: number } | null
      /** 展開 Agent 輸出的那件（卡片路徑）與讀到的最近幾行。 */
      logsOpen: string | null
      logView: Record<string, string[]>
      /** 顯示快捷鍵說明。 */
      isHelp: boolean
      /** footer 展開全部動作（m）：展開當下現在卡的卡片路徑（沒有現在卡是空字串），收合是 null。 */
      showAllActions: string | null
      /** 面板中間 content 捲到第幾列（header 與 footer 常駐不捲）。 */
      contentOffset: number
      /** desk 在這個 session 載入了幾次（含 /reload-plugins）；更新後判斷新版是否已載入。 */
      loads: number
    }
  }
}
