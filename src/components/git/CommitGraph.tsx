import { Tag } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from '@/lib/dates'
import { refLabels } from '@/lib/git/refs'
import {
  layoutGraph,
  type GraphEdge,
  type GraphRow,
} from '@/lib/git/graph-layout'
import type { GraphCommit, RefKind } from '@/lib/git/types'

interface CommitGraphProps {
  /** Newest first, in topological order, as `gitLogGraph` returns them. */
  commits: GraphCommit[]
  selectedId?: string | null
  onSelect?: (id: string) => void
  /** The checked-out branch, whose label is marked */
  currentBranch?: string | null
  /** The time relative dates are measured from (fixed in the styleguide). */
  now?: Date
}

const ROW_HEIGHT = 32
const LANE_WIDTH = 14
const GRAPH_PADDING = 10
const DOT_RADIUS = 4

// Full class names so Tailwind finds them; one per --git-lane-* token
const LANE_STROKE = [
  'stroke-git-lane-0',
  'stroke-git-lane-1',
  'stroke-git-lane-2',
  'stroke-git-lane-3',
  'stroke-git-lane-4',
  'stroke-git-lane-5',
  'stroke-git-lane-6',
  'stroke-git-lane-7',
]
const LANE_FILL = [
  'fill-git-lane-0',
  'fill-git-lane-1',
  'fill-git-lane-2',
  'fill-git-lane-3',
  'fill-git-lane-4',
  'fill-git-lane-5',
  'fill-git-lane-6',
  'fill-git-lane-7',
]

const laneX = (lane: number) =>
  GRAPH_PADDING + lane * LANE_WIDTH + LANE_WIDTH / 2
const rowY = (row: number) => row * ROW_HEIGHT + ROW_HEIGHT / 2

/** An SVG path from a row's dot level down to the next row's. */
function edgePath(row: number, edge: GraphEdge): string {
  const x1 = laneX(edge.fromLane)
  const x2 = laneX(edge.toLane)
  const y1 = rowY(row)
  const y2 = rowY(row + 1)
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`
  const mid = (y1 + y2) / 2
  return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`
}

/**
 * The commit history as a graph: one row per commit, with coloured lane lines,
 * merge curves and a dot on the commit's lane, followed by its branch and tag
 * labels, summary, author and how long ago it was made. The lanes are one SVG
 * behind the rows, so lines run unbroken from row to row.
 */
export function CommitGraph({
  commits,
  selectedId,
  onSelect,
  currentBranch = null,
  now,
}: CommitGraphProps) {
  const rows = layoutGraph(commits)
  const lanes = Math.max(1, ...rows.map(row => row.laneCount))
  const graphWidth = GRAPH_PADDING * 2 + lanes * LANE_WIDTH
  const height = rows.length * ROW_HEIGHT

  return (
    <div className="relative" style={{ height }}>
      <svg
        aria-hidden
        data-testid="commit-graph-lanes"
        width={graphWidth}
        height={height}
        className="pointer-events-none absolute top-0 left-0 overflow-hidden"
      >
        {rows.map((row, index) =>
          row.edges.map((edge, edgeIndex) => (
            <path
              key={`${row.commit.id}-${edgeIndex}`}
              d={edgePath(index, edge)}
              className={cn('fill-none', LANE_STROKE[edge.colorIndex])}
              strokeWidth={2}
            />
          ))
        )}
        {rows.map((row, index) => (
          <circle
            key={row.commit.id}
            cx={laneX(row.lane)}
            cy={rowY(index)}
            r={DOT_RADIUS}
            className={cn(
              'stroke-background',
              LANE_FILL[row.colorIndex],
              row.commit.parents.length > 1 && 'fill-background',
              row.commit.parents.length > 1 && LANE_STROKE[row.colorIndex]
            )}
            strokeWidth={2}
          />
        ))}
      </svg>
      <ul className="list-none p-0">
        {rows.map(row => (
          <CommitRow
            key={row.commit.id}
            row={row}
            indent={graphWidth}
            selected={row.commit.id === selectedId}
            onSelect={onSelect}
            currentBranch={currentBranch}
            now={now}
          />
        ))}
      </ul>
    </div>
  )
}

function CommitRow({
  row,
  indent,
  selected,
  onSelect,
  currentBranch,
  now,
}: {
  row: GraphRow
  indent: number
  selected: boolean
  onSelect?: (id: string) => void
  currentBranch: string | null
  now?: Date
}) {
  const { commit } = row
  const date = new Date(commit.time * 1000)
  return (
    <li style={{ height: ROW_HEIGHT }}>
      <button
        type="button"
        aria-current={selected || undefined}
        onClick={() => onSelect?.(commit.id)}
        className={cn(
          'flex h-full w-full items-center gap-3 pr-4 text-left text-sm transition-colors',
          selected ? 'bg-primary/10' : 'hover:bg-accent/70'
        )}
        style={{ paddingLeft: indent }}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {refLabels(commit.refs, currentBranch).map(label => (
            <RefLabel
              key={`${label.kind}:${label.name}`}
              name={label.name}
              kind={label.kind}
              current={label.current}
              colorIndex={row.colorIndex}
            />
          ))}
          <span className="truncate text-foreground">{commit.summary}</span>
        </span>
        <span className="max-w-40 shrink-0 truncate text-xs text-muted-foreground">
          {commit.authorName}
        </span>
        <time
          dateTime={date.toISOString()}
          title={date.toLocaleString()}
          className="w-24 shrink-0 text-right text-xs text-muted-foreground"
        >
          {formatRelativeTime(date, now)}
        </time>
      </button>
    </li>
  )
}

const LANE_BORDER = [
  'border-git-lane-0 text-git-lane-0',
  'border-git-lane-1 text-git-lane-1',
  'border-git-lane-2 text-git-lane-2',
  'border-git-lane-3 text-git-lane-3',
  'border-git-lane-4 text-git-lane-4',
  'border-git-lane-5 text-git-lane-5',
  'border-git-lane-6 text-git-lane-6',
  'border-git-lane-7 text-git-lane-7',
]

function RefLabel({
  name,
  kind,
  current,
  colorIndex,
}: {
  name: string
  kind: RefKind
  current: boolean
  colorIndex: number
}) {
  return (
    <span
      data-testid="ref-label"
      aria-current={current || undefined}
      title={current ? 'You are on this branch' : REF_TITLES[kind]}
      className={cn(
        'inline-flex h-5 max-w-40 shrink-0 items-center gap-1 truncate rounded-md border px-1.5 text-[11px] leading-none font-medium',
        kind === 'tag'
          ? 'border-border text-muted-foreground'
          : LANE_BORDER[colorIndex],
        kind === 'remoteBranch' && 'border-dashed font-normal',
        current && 'bg-accent'
      )}
    >
      {kind === 'tag' && <Tag aria-hidden className="size-3" />}
      {name}
    </span>
  )
}

const REF_TITLES: Record<RefKind, string> = {
  head: 'The version you have open (not on a branch)',
  localBranch: 'Branch',
  remoteBranch: 'Remote branch',
  tag: 'Tag',
}
