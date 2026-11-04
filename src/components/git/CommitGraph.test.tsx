import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CommitGraph } from './CommitGraph'
import type { GraphCommit } from '@/lib/git/types'

const NOW = new Date(2026, 10, 3, 12, 0, 0)
const HOUR = 3600

function commit(
  id: string,
  parents: string[],
  hoursAgo: number,
  refs: GraphCommit['refs'] = []
): GraphCommit {
  return {
    id,
    shortId: id.slice(0, 7),
    parents,
    summary: `Summary of ${id}`,
    authorName: 'Kevin Robinson',
    time: NOW.getTime() / 1000 - hoursAgo * HOUR,
    refs,
  }
}

const COMMITS: GraphCommit[] = [
  commit('merge01', ['main002', 'side001'], 1, [
    { name: 'HEAD', kind: 'head' },
    { name: 'main', kind: 'localBranch' },
    { name: 'origin/main', kind: 'remoteBranch' },
  ]),
  commit('side001', ['main001'], 2, [{ name: 'staging', kind: 'localBranch' }]),
  commit('main002', ['main001'], 3),
  commit('main001', [], 30, [{ name: 'v1.0', kind: 'tag' }]),
]

describe('CommitGraph', () => {
  it('renders one row per commit', () => {
    render(<CommitGraph commits={COMMITS} now={NOW} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
  })

  it('renders a label for each ref, marking the current branch for HEAD', () => {
    render(<CommitGraph commits={COMMITS} now={NOW} currentBranch="main" />)
    const labels = screen.getAllByTestId('ref-label')
    expect(labels.map(l => l.textContent)).toEqual([
      'main',
      'origin/main',
      'staging',
      'v1.0',
    ])
    expect(labels[0]).toHaveAttribute('aria-current', 'true')
  })

  it('shows the summary, author and relative date', () => {
    render(<CommitGraph commits={COMMITS} now={NOW} />)
    const row = screen.getAllByRole('listitem')[0] as HTMLElement
    expect(within(row).getByText('Summary of merge01')).toBeInTheDocument()
    expect(within(row).getByText('Kevin Robinson')).toBeInTheDocument()
    expect(within(row).getByText('1 hour ago')).toBeInTheDocument()
  })

  it('draws a dot per commit', () => {
    render(<CommitGraph commits={COMMITS} now={NOW} />)
    const lanes = screen.getByTestId('commit-graph-lanes')
    expect(lanes.querySelectorAll('circle')).toHaveLength(4)
  })

  it('selects a commit on click', async () => {
    const onSelect = vi.fn()
    render(<CommitGraph commits={COMMITS} now={NOW} onSelect={onSelect} />)
    await userEvent.click(screen.getByText('Summary of side001'))
    expect(onSelect).toHaveBeenCalledWith('side001')
  })

  it('marks the selected commit', () => {
    render(<CommitGraph commits={COMMITS} now={NOW} selectedId="main002" />)
    const selected = screen.getByRole('button', { current: true })
    expect(selected).toHaveTextContent('Summary of main002')
  })
})
