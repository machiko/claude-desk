// 容器：讀 `docker compose ps -a --format json`（每行一個服務，或整個陣列），整理成一列摘要；
// 並判斷一條完成檢查要用到哪些服務。純函式。
export type ContainerInfo = { service: string; state: string; health: string }
export type ContainerSummary = { total: number; running: number; down: string[]; unhealthy: string[]; error?: string }

export function parseCompose(text: string): ContainerInfo[] {
  const t = String(text ?? '').trim()
  if (!t) return []
  let rows: any[] = []
  try { rows = t.startsWith('[') ? JSON.parse(t) : t.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)) } catch { return [] }
  return rows.filter(r => r && typeof r.Service === 'string').map(r => ({ service: r.Service, state: String(r.State ?? '').toLowerCase(), health: String(r.Health ?? '').toLowerCase() }))
}

export function summarize(list: ContainerInfo[]): ContainerSummary {
  const down = list.filter(c => c.state !== 'running').map(c => c.service)
  const unhealthy = list.filter(c => c.state === 'running' && c.health === 'unhealthy').map(c => c.service)
  return { total: list.length, running: list.length - down.length, down, unhealthy }
}

/**
 * 一條完成檢查要用到哪些服務：`docker compose exec [-T] [-w 路徑] <服務>` 的那個服務；
 * 加上設定檔 checkServices 指定的指令（例如包好的測試腳本用主工作區的資料庫）。每一段（`&&` 串起來的）都看。
 */
export function servicesFor(command: string, extra: Record<string, string[]> = {}): string[] {
  const out = new Set<string>()
  for (const part of String(command ?? '').split(/\s*(?:&&|\|\||;)\s*/)) {
    const m = part.match(/docker[- ]compose\s+exec\s+((?:-[A-Za-z]+\s+(?:\S+\s+)?)*)([A-Za-z0-9_.-]+)/)
    if (m) {
      // 選項後面可能帶值（-w /var/www）；把它們從頭剝掉，剩下的第一個字才是服務名。
      const words = part.replace(/^.*?docker[- ]compose\s+exec\s+/, '').split(/\s+/)
      let i = 0
      while (i < words.length && words[i]!.startsWith('-')) { i += /^-(w|u|e|-workdir|-user|-env)$/.test(words[i]!) ? 2 : 1 }
      if (words[i]) out.add(words[i]!)
    }
    for (const [cmd, svcs] of Object.entries(extra)) {
      if (new RegExp(`(^|/)${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(part)) svcs.forEach(v => out.add(v))
    }
  }
  return [...out]
}

/** 這條檢查要的服務裡，哪些沒在跑；讀不到容器狀態時不擋（交給檢查自己失敗）。 */
export function missingServices(command: string, s: ContainerSummary | undefined, extra: Record<string, string[]> = {}): string[] {
  if (!s || s.error || s.total === 0) return []
  return servicesFor(command, extra).filter(svc => s.down.includes(svc))
}
