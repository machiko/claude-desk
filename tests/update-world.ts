// desk 自我更新的測試世界：模擬 desk 的安裝（claude plugin）與 desk 自己的 git。update 與 release-update 的測試共用。
import { result } from './fixture'

export const MARKET_DIR = '/home/u/.claude/plugins/marketplaces/claude-desk'
export const FOLDER = '/home/u/Workspace/claude-desk'

export type World = { kind: 'github' | 'folder'; installed: string; latest: string; dirty?: boolean; branch?: string; ahead?: number; fetchFails?: boolean; updateFails?: boolean }

/** 模擬 desk 的安裝（claude plugin list／marketplace list／update）與 desk 自己的 git；記下每個會改東西的指令。 */
export function world(data: any, w: World) {
  const calls: string[][] = []
  const changes: string[] = []
  let merged = false
  /** 本機資料夾目前的 HEAD：快轉到 GitHub 的版本、reset --keep 退回。 */
  const folder = { head: 'aaaa111' }
  const dir = w.kind === 'folder' ? FOLDER : MARKET_DIR
  data.deskVersion = w.installed
  data.exec = (e: any) => {
    const argv: string[] = e.argv
    if (argv[0] === 'claude' && argv[1] === 'plugin') {
      calls.push(argv)
      const rest = argv.slice(2).join(' ')
      if (rest === 'list --json') return result(0, JSON.stringify([
        { id: 'other@x', version: '1.0.0', scope: 'user', enabled: true, installPath: '/home/u/.claude/plugins/cache/x/other/1.0.0' },
        { id: 'desk@claude-desk', version: w.installed, scope: 'user', enabled: true, installPath: `/home/u/.claude/plugins/cache/claude-desk/desk/${w.installed}`, ...(w.kind === 'folder' ? { readFromFolder: FOLDER, folderVersion: w.installed } : {}) },
      ]))
      if (rest === 'marketplace list --json') return result(0, JSON.stringify([
        w.kind === 'folder' ? { name: 'claude-desk', source: 'directory', path: FOLDER, installLocation: FOLDER } : { name: 'claude-desk', source: 'github', repo: 'machiko/claude-desk', installLocation: MARKET_DIR },
      ]))
      if (rest.startsWith('marketplace update')) { changes.push(rest); return result(0, 'updated') }
      if (rest.startsWith('update ')) {
        if (w.updateFails) return result(1, '', 'Failed to update plugin desk@claude-desk: network down\nmore detail')
        changes.push(rest)
        if (w.kind === 'github' || merged) w.installed = w.latest
        return result(0, 'Restart to apply')
      }
      return result(1, '', `unexpected: ${rest}`)
    }
    if (argv[0] === 'git' && argv[2] === dir) {
      calls.push(argv)
      const args = argv.slice(3).join(' ')
      if (args.startsWith('fetch')) return w.fetchFails ? result(128, '', 'fatal: unable to access \'https://github.com/machiko/claude-desk.git/\': Could not resolve host: github.com\nsecond line') : result(0)
      if (args === 'symbolic-ref --short refs/remotes/origin/HEAD') return result(0, 'origin/main\n')
      if (args === 'show origin/main:.claude-plugin/marketplace.json') return result(0, JSON.stringify({ name: 'claude-desk', plugins: [{ name: 'desk', source: './' }] }))
      if (args === 'show origin/main:.claude-plugin/plugin.json') return result(0, JSON.stringify({ name: 'desk', version: w.latest }))
      if (args.startsWith('status --porcelain')) return result(0, w.dirty ? ' M hooks/pane.tsx\n' : '')
      if (args === 'rev-parse --abbrev-ref HEAD') return result(0, `${w.branch ?? 'main'}\n`)
      if (args === 'rev-list --count origin/main..HEAD') return result(0, `${w.ahead ?? 0}\n`)
      if (args === 'rev-parse HEAD') return result(0, `${folder.head}\n`)
      if (args.startsWith('merge')) { changes.push(`git ${args}`); merged = true; folder.head = 'bbbb222'; return result(0) }
      if (args.startsWith('reset --keep')) { changes.push(`git ${args}`); merged = false; folder.head = argv[argv.length - 1]!; return result(0) }
      changes.push(`git ${args}`)
      return result(0)
    }
    return null
  }
  return { calls, changes, w, folder }
}
