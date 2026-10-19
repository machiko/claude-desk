import { expect, test } from 'claude-code/testing'
import { READ_TOOL, repoOf, prQuery, statusQuery, mcpJson, pickPr, ciOf } from '../hooks/bitbucket'

test('only the read tool is ever named', () => {
  expect(READ_TOOL).toBe('bb_get')
})

test('repo from ssh or https remotes; others are null', () => {
  expect(repoOf('git@bitbucket.org:acme/shop.git')).toEqual({ workspace: 'acme', repo: 'shop' })
  expect(repoOf('https://dev@bitbucket.org/acme/shop.git')).toEqual({ workspace: 'acme', repo: 'shop' })
  expect(repoOf('git@github.com:a/b.git')).toBeNull()
})

test('queries filter by branch and ask for json', () => {
  const q = prQuery({ workspace: 'w', repo: 'r' }, 'feature/a"b')
  expect(q.path).toBe('/repositories/w/r/pullrequests')
  expect(q.queryParams.q).toBe('source.branch.name="feature/ab" AND (state="OPEN" OR state="MERGED" OR state="DECLINED")')
  expect(q.outputFormat).toBe('json')
  expect(statusQuery({ workspace: 'w', repo: 'r' }, 7).path).toBe('/repositories/w/r/pullrequests/7/statuses')
})

test('results: open wins, ci rolls up', () => {
  const r = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }], isError: false })
  expect(pickPr(mcpJson(r([{ id: 3, state: 'MERGED' }, { id: 5, state: 'OPEN', dest: 'release/v1' }])))).toEqual({ id: 5, state: 'OPEN', dest: 'release/v1' })
  expect(pickPr(mcpJson(r([])))).toBeNull()
  expect(mcpJson({ content: [{ type: 'text', text: 'boom' }], isError: true })).toBeNull()
  expect(ciOf(['SUCCESSFUL', 'INPROGRESS'])).toBe('pending')
  expect(ciOf(['SUCCESSFUL', 'FAILED'])).toBe('fail')
  expect(ciOf(['SUCCESSFUL'])).toBe('pass')
  expect(ciOf([])).toBe('none')
})
