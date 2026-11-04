import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import type { GitStatus } from '@/lib/bindings'
import { queryKeys } from '@/lib/query-keys'
import { applyFetchedStatus } from './cache'

const STATUS: GitStatus = {
  isRepo: true,
  branch: 'main',
  defaultBranch: 'main',
  upstream: 'origin/main',
  ahead: 1,
  behind: 1,
  files: [],
  detached: false,
}

describe('applyFetchedStatus', () => {
  it('reloads what a fetch can change, the conflict list included', () => {
    const client = new QueryClient()
    const keys = [
      queryKeys.gitBranches('/site'),
      queryKeys.gitBehindDefault('/site'),
      queryKeys.gitAheadOfDefault('/site'),
      queryKeys.gitConflicts('/site'),
      queryKeys.pullRequests('/site'),
    ]
    for (const key of keys) client.setQueryData(key, [])
    applyFetchedStatus(client, '/site', STATUS)
    expect(client.getQueryData(queryKeys.gitStatus('/site'))).toEqual(STATUS)
    for (const key of keys) {
      expect(client.getQueryState(key)?.isInvalidated, String(key)).toBe(true)
    }
  })
})
