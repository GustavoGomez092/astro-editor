import type { GraphCommit } from './types'

/** Number of lane colour tokens (`--git-lane-0` … `--git-lane-7`). */
export const LANE_COLOR_COUNT = 8

export type GraphEdgeKind = 'straight' | 'merge' | 'branch'

/**
 * A line from this row's dot level down to the next row's dot level.
 * `straight` keeps its lane; `merge` runs from a merge commit out to the lane
 * of a parent it brought in; `branch` runs from a commit back into the lane
 * where its parent already waits (where a branch started).
 */
export interface GraphEdge {
  fromLane: number
  toLane: number
  colorIndex: number
  kind: GraphEdgeKind
}

export interface GraphRow {
  commit: GraphCommit
  lane: number
  colorIndex: number
  edges: GraphEdge[]
  /** Lanes this row touches, from the line above it to the line below it. */
  laneCount: number
}

interface Lane {
  /** The commit id this lane is waiting for. */
  expects: string
  colorIndex: number
}

/**
 * Lays out commits (newest first, topologically ordered) on lanes, using the
 * classic "active lanes" algorithm: each lane holds the id of the commit it
 * expects next. A commit takes the lane expecting it or the first free one;
 * its first parent continues that lane, and any other parent joins the lane
 * already expecting it or opens a new one. When two lanes would wait for the
 * same parent, the one further right ends and joins the other, so at most one
 * lane waits for any commit, the older line stays on the left, and freed lanes
 * are reused.
 */
export function layoutGraph(commits: GraphCommit[]): GraphRow[] {
  const lanes: (Lane | null)[] = []
  const rows: GraphRow[] = []
  let nextColor = 0

  const takeColor = () => {
    const color = nextColor
    nextColor = (nextColor + 1) % LANE_COLOR_COUNT
    return color
  }
  const laneExpecting = (id: string) =>
    lanes.findIndex(lane => lane?.expects === id)
  const firstFreeLane = () => {
    const free = lanes.indexOf(null)
    return free === -1 ? lanes.length : free
  }
  const activeWidth = () => {
    let width = lanes.length
    while (width > 0 && lanes[width - 1] === null) width--
    return width
  }

  for (const commit of commits) {
    const widthAbove = activeWidth()

    let lane = laneExpecting(commit.id)
    if (lane === -1) {
      lane = firstFreeLane()
      lanes[lane] = { expects: commit.id, colorIndex: takeColor() }
    }
    const own = lanes[lane] as Lane
    const colorIndex = own.colorIndex

    // Lanes that pass by this commit untouched.
    const passing: number[] = []
    lanes.forEach((other, index) => {
      if (other && index !== lane) passing.push(index)
    })

    const edges: GraphEdge[] = []
    const [firstParent, ...otherParents] = commit.parents

    if (firstParent === undefined) {
      lanes[lane] = null
    } else {
      const waiting = laneExpecting(firstParent)
      if (waiting === -1 || waiting > lane) {
        own.expects = firstParent
        edges.push({
          fromLane: lane,
          toLane: lane,
          colorIndex,
          kind: 'straight',
        })
        if (waiting > lane) {
          // The parent waits further right: that lane ends here and joins
          // this one, so the older line stays on the left.
          const joining = lanes[waiting] as Lane
          lanes[waiting] = null
          passing.splice(passing.indexOf(waiting), 1)
          edges.push({
            fromLane: waiting,
            toLane: lane,
            colorIndex: joining.colorIndex,
            kind: 'branch',
          })
        }
      } else {
        lanes[lane] = null
        edges.push({
          fromLane: lane,
          toLane: waiting,
          colorIndex,
          kind: 'branch',
        })
      }
    }

    for (const parent of otherParents) {
      let target = laneExpecting(parent)
      if (target === -1) {
        target = firstFreeLane()
        lanes[target] = { expects: parent, colorIndex: takeColor() }
      }
      const targetColor = (lanes[target] as Lane).colorIndex
      edges.push({
        fromLane: lane,
        toLane: target,
        colorIndex: targetColor,
        kind: 'merge',
      })
    }

    for (const index of passing) {
      const other = lanes[index] as Lane
      edges.push({
        fromLane: index,
        toLane: index,
        colorIndex: other.colorIndex,
        kind: 'straight',
      })
    }

    let laneCount = Math.max(widthAbove, lane + 1)
    for (const edge of edges) {
      laneCount = Math.max(laneCount, edge.fromLane + 1, edge.toLane + 1)
    }

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()

    rows.push({ commit, lane, colorIndex, edges, laneCount })
  }

  return rows
}
