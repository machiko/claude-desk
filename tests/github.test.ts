import { expect, test } from 'claude-code/testing'
import { GH_READ, githubRepoOf, ghPrArgs, pickGhPr, ghCiOf } from '../hooks/github'

test('only gh pr list is ever run', () => {
  expect(GH_READ).toEqual(['pr', 'list'])
  expect(ghPrArgs({ owner: 'acme', repo: 'shop' }, 'feature/a').slice(0, 3)).toEqual(['gh', ...GH_READ])
})

test('repo from ssh or https remotes; others are null', () => {
  expect(githubRepoOf('git@github.com:acme/shop.git')).toEqual({ owner: 'acme', repo: 'shop' })
  expect(githubRepoOf('https://github.com/acme/shop')).toEqual({ owner: 'acme', repo: 'shop' })
  expect(githubRepoOf('ssh://git@github.com/acme/shop.git')).toEqual({ owner: 'acme', repo: 'shop' })
  expect(githubRepoOf('git@bitbucket.org:acme/shop.git')).toBeNull()
  expect(githubRepoOf('')).toBeNull()
})

test('the query names the repo and the branch and asks for json', () => {
  const args = ghPrArgs({ owner: 'acme', repo: 'shop' }, 'feature/a')
  expect(args).toContain('--repo')
  expect(args[args.indexOf('--repo') + 1]).toBe('acme/shop')
  expect(args[args.indexOf('--head') + 1]).toBe('feature/a')
  expect(args[args.indexOf('--state') + 1]).toBe('all')
  expect(args[args.indexOf('--json') + 1]).toBe('number,state,baseRefName,url,headRepositoryOwner,statusCheckRollup')
})

test('open wins; closed reads as declined; ci only for open', () => {
  const merged = { number: 3, state: 'MERGED', baseRefName: 'main', url: 'https://github.com/acme/shop/pull/3', statusCheckRollup: [{ conclusion: 'FAILURE', status: 'COMPLETED' }] }
  const open = { number: 5, state: 'OPEN', baseRefName: 'main', url: 'https://github.com/acme/shop/pull/5', statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }] }
  expect(pickGhPr([merged, open])).toEqual({ id: 5, state: 'OPEN', ci: 'pass', dest: 'main', url: 'https://github.com/acme/shop/pull/5' })
  expect(pickGhPr([merged])).toEqual({ id: 3, state: 'MERGED', ci: 'none', dest: 'main', url: 'https://github.com/acme/shop/pull/3' })
  expect(pickGhPr([{ number: 7, state: 'CLOSED', baseRefName: 'main' }])?.state).toBe('DECLINED')
  expect(pickGhPr([])).toBeNull()
  expect(pickGhPr('boom')).toBeNull()
})

test('ci rolls up check runs and status contexts', () => {
  expect(ghCiOf([])).toBe('none')
  expect(ghCiOf(undefined)).toBe('none')
  expect(ghCiOf([{ conclusion: 'SUCCESS', status: 'COMPLETED' }, { conclusion: 'SKIPPED', status: 'COMPLETED' }])).toBe('pass')
  expect(ghCiOf([{ conclusion: 'SUCCESS', status: 'COMPLETED' }, { conclusion: '', status: 'IN_PROGRESS' }])).toBe('pending')
  expect(ghCiOf([{ state: 'PENDING' }])).toBe('pending')
  expect(ghCiOf([{ conclusion: '', status: 'IN_PROGRESS' }, { conclusion: 'FAILURE', status: 'COMPLETED' }])).toBe('fail')
  expect(ghCiOf([{ state: 'ERROR' }])).toBe('fail')
  expect(ghCiOf([{ conclusion: 'TIMED_OUT', status: 'COMPLETED' }])).toBe('fail')
})

test('the host must really be github.com', () => {
  expect(githubRepoOf('https://notgithub.com/acme/shop')).toBeNull()
  expect(githubRepoOf('git@evilgithub.com:acme/shop.git')).toBeNull()
})

test('a PR from someone else\'s fork with the same branch name is not ours', () => {
  const fork = { number: 8, state: 'OPEN', baseRefName: 'main', headRepositoryOwner: { login: 'stranger' }, statusCheckRollup: [] }
  const mine = { number: 4, state: 'MERGED', baseRefName: 'main', headRepositoryOwner: { login: 'acme' }, statusCheckRollup: [] }
  expect(pickGhPr([fork, mine], 'acme')?.id).toBe(4)
  expect(pickGhPr([fork], 'acme')).toBeNull()
  expect(ghPrArgs({ owner: 'acme', repo: 'shop' }, 'main').join(' ')).toContain('headRepositoryOwner')
})
