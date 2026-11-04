import { describe, expect, it } from 'vitest'
import { layoutGraph, LANE_COLOR_COUNT } from './graph-layout'
import type { GraphCommit } from './types'

function commit(id: string, parents: string[] = []): GraphCommit {
  return {
    id,
    shortId: id.slice(0, 7),
    parents,
    summary: `Commit ${id}`,
    authorName: 'Writer',
    time: 0,
    refs: [],
  }
}

describe('layoutGraph', () => {
  it('returns no rows for no commits', () => {
    expect(layoutGraph([])).toEqual([])
  })

  it('keeps linear history on lane 0', () => {
    const rows = layoutGraph([
      commit('c', ['b']),
      commit('b', ['a']),
      commit('a'),
    ])

    expect(rows.map(r => r.lane)).toEqual([0, 0, 0])
    expect(rows.map(r => r.laneCount)).toEqual([1, 1, 1])
    expect(rows[0]?.edges).toEqual([
      { fromLane: 0, toLane: 0, colorIndex: 0, kind: 'straight' },
    ])
    // The root commit has nothing below it.
    expect(rows[2]?.edges).toEqual([])
  })

  it('opens a second lane for a merged branch and draws a merge edge', () => {
    // m merges side branch s into main; both start from a.
    const rows = layoutGraph([
      commit('m', ['b', 's']),
      commit('s', ['a']),
      commit('b', ['a']),
      commit('a'),
    ])
    const [m, s, b, a] = rows

    expect(m?.lane).toBe(0)
    expect(m?.edges).toContainEqual(
      expect.objectContaining({ fromLane: 0, toLane: 0, kind: 'straight' })
    )
    expect(m?.edges).toContainEqual(
      expect.objectContaining({ fromLane: 0, toLane: 1, kind: 'merge' })
    )
    expect(m?.laneCount).toBe(2)

    // The side commit sits on lane 1 while main passes by on lane 0.
    expect(s?.lane).toBe(1)
    expect(s?.colorIndex).not.toBe(m?.colorIndex)
    expect(s?.edges).toContainEqual(
      expect.objectContaining({ fromLane: 0, toLane: 0, kind: 'straight' })
    )

    // Both now wait for a: the side lane branches back into main's lane,
    // which keeps going on the left.
    expect(b?.lane).toBe(0)
    expect(b?.edges).toContainEqual(
      expect.objectContaining({ fromLane: 0, toLane: 0, kind: 'straight' })
    )
    expect(b?.edges).toContainEqual(
      expect.objectContaining({ fromLane: 1, toLane: 0, kind: 'branch' })
    )
    expect(a?.lane).toBe(0)
    expect(a?.laneCount).toBe(1)
  })

  it('colours a merge edge like the branch it brings in', () => {
    const rows = layoutGraph([
      commit('m', ['b', 's']),
      commit('s', ['a']),
      commit('b', ['a']),
      commit('a'),
    ])
    const merge = rows[0]?.edges.find(e => e.kind === 'merge')
    expect(merge?.colorIndex).toBe(rows[1]?.colorIndex)
  })

  it('keeps two parallel branches on stable lanes and colours', () => {
    // Two branch tips, x and y, interleaved in time, both from a.
    const rows = layoutGraph([
      commit('x2', ['x1']),
      commit('y2', ['y1']),
      commit('x1', ['a']),
      commit('y1', ['a']),
      commit('a'),
    ])
    const byId = new Map(rows.map(r => [r.commit.id, r]))

    expect(byId.get('x2')?.lane).toBe(0)
    expect(byId.get('x1')?.lane).toBe(0)
    expect(byId.get('y2')?.lane).toBe(1)
    expect(byId.get('y1')?.lane).toBe(1)
    expect(byId.get('x1')?.colorIndex).toBe(byId.get('x2')?.colorIndex)
    expect(byId.get('y1')?.colorIndex).toBe(byId.get('y2')?.colorIndex)
    expect(byId.get('x2')?.colorIndex).not.toBe(byId.get('y2')?.colorIndex)

    // While y waits for its next commit, its lane passes straight through
    // x1's row in y's colour.
    expect(byId.get('x1')?.edges).toContainEqual({
      fromLane: 1,
      toLane: 1,
      colorIndex: byId.get('y2')?.colorIndex,
      kind: 'straight',
    })
  })

  it('reuses a lane after a branch ends', () => {
    const rows = layoutGraph([
      commit('m2', ['b2', 'f2']),
      commit('f2', ['b2']),
      commit('b2', ['m1']),
      commit('m1', ['b1', 'f1']),
      commit('f1', ['b1']),
      commit('b1'),
    ])
    const byId = new Map(rows.map(r => [r.commit.id, r]))

    expect(byId.get('f2')?.lane).toBe(1)
    expect(byId.get('b2')?.laneCount).toBe(1)
    // The second feature branch reuses lane 1 instead of opening lane 2.
    expect(byId.get('f1')?.lane).toBe(1)
    expect(Math.max(...rows.map(r => r.laneCount))).toBe(2)
  })

  it('gives a branch tip the first free lane', () => {
    const rows = layoutGraph([
      commit('t1', ['a']),
      commit('t2', ['a']),
      commit('a'),
    ])
    expect(rows[1]?.lane).toBe(1)
    expect(rows[1]?.edges).toContainEqual(
      expect.objectContaining({ fromLane: 1, toLane: 0, kind: 'branch' })
    )
    expect(rows[2]?.lane).toBe(0)
  })

  it('keeps colour indexes inside the token range', () => {
    const commits: GraphCommit[] = []
    for (let i = 0; i < 20; i++) commits.push(commit(`tip${i}`, ['base']))
    commits.push(commit('base'))
    for (const row of layoutGraph(commits)) {
      expect(row.colorIndex).toBeGreaterThanOrEqual(0)
      expect(row.colorIndex).toBeLessThan(LANE_COLOR_COUNT)
      for (const edge of row.edges) {
        expect(edge.colorIndex).toBeLessThan(LANE_COLOR_COUNT)
      }
    }
  })

  it('continues a lane whose parent is beyond the loaded history', () => {
    const rows = layoutGraph([commit('b', ['a'])])
    expect(rows[0]?.edges).toEqual([
      { fromLane: 0, toLane: 0, colorIndex: 0, kind: 'straight' },
    ])
  })

  it('lays out 300 commits in under 20 ms', () => {
    // Main line with a feature branch merged every 10 commits.
    const commits: GraphCommit[] = []
    for (let i = 0; i < 300; i++) {
      const parent = i < 299 ? [`c${i + 1}`] : []
      if (i % 10 === 0 && i + 2 < 300) {
        commits.push(commit(`c${i}`, [...parent, `f${i}`]))
      } else {
        commits.push(commit(`c${i}`, parent))
      }
      if (i % 10 === 1 && i + 1 < 300) {
        commits.push(commit(`f${i - 1}`, [`c${i + 1}`]))
      }
    }
    const input = commits.slice(0, 300)

    layoutGraph(input) // warm up
    const start = performance.now()
    const rows = layoutGraph(input)
    const elapsed = performance.now() - start

    expect(rows).toHaveLength(300)
    expect(elapsed).toBeLessThan(20)
  })
})
