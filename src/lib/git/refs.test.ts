import { describe, expect, it } from 'vitest'
import type { GraphRef } from '@/lib/bindings'
import { refLabels } from './refs'

const HEAD: GraphRef = { name: 'HEAD', kind: 'head' }
const local = (name: string): GraphRef => ({ name, kind: 'localBranch' })

describe('refLabels', () => {
  it('marks the current branch instead of showing HEAD', () => {
    expect(
      refLabels([HEAD, local('main'), local('staging')], 'staging')
    ).toEqual([
      { name: 'main', kind: 'localBranch', current: false },
      { name: 'staging', kind: 'localBranch', current: true },
    ])
  })

  it('keeps HEAD when it points at no branch (detached)', () => {
    expect(refLabels([HEAD, local('main')], null)).toEqual([
      { name: 'HEAD', kind: 'head', current: true },
      { name: 'main', kind: 'localBranch', current: false },
    ])
  })

  it('leaves other commits alone', () => {
    expect(
      refLabels([{ name: 'origin/main', kind: 'remoteBranch' }], 'main')
    ).toEqual([{ name: 'origin/main', kind: 'remoteBranch', current: false }])
  })
})
