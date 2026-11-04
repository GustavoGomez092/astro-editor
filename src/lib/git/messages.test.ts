import { describe, expect, it } from 'vitest'
import { syncToastKind } from './messages'

describe('syncToastKind', () => {
  it('celebrates changes brought in', () => {
    expect(syncToastKind('fastForwarded')).toBe('success')
    expect(syncToastKind('merged')).toBe('success')
  })
  it('stays quiet when there was nothing to do', () => {
    expect(syncToastKind('upToDate')).toBe('info')
    expect(syncToastKind('noUpstream')).toBe('info')
  })
  it('warns when the writer has something to sort out', () => {
    expect(syncToastKind('blockedByLocalChanges')).toBe('warning')
    expect(syncToastKind('conflict')).toBe('warning')
  })
})
