import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DiffView } from './DiffView'
import type { FileDiff } from '@/lib/bindings'

const TEXT_DIFF: FileDiff = {
  path: 'src/content/articles/first-post.md',
  binary: false,
  isImage: false,
  hunks: [
    {
      header: '@@ -3,3 +3,3 @@',
      lines: [
        { kind: 'ctx', text: 'title: First post', oldNo: 3, newNo: 3 },
        { kind: 'del', text: 'draft: true', oldNo: 4, newNo: null },
        { kind: 'add', text: 'draft: false', oldNo: null, newNo: 4 },
      ],
    },
  ],
}

describe('DiffView', () => {
  it('renders added, removed and unchanged lines with their line numbers', () => {
    render(<DiffView diff={TEXT_DIFF} />)

    const rows = screen.getAllByTestId('diff-line')
    expect(rows.map(r => r.dataset.kind)).toEqual(['ctx', 'del', 'add'])

    const [ctx, del, add] = rows
    expect(ctx).toHaveTextContent('title: First post')
    expect(ctx?.querySelector('[data-col="old"]')).toHaveTextContent('3')
    expect(ctx?.querySelector('[data-col="new"]')).toHaveTextContent('3')
    expect(del).toHaveTextContent('draft: true')
    expect(del?.querySelector('[data-col="old"]')).toHaveTextContent('4')
    expect(del?.querySelector('[data-col="new"]')).toBeEmptyDOMElement()
    expect(add).toHaveTextContent('draft: false')
    expect(add?.querySelector('[data-col="new"]')).toHaveTextContent('4')
  })

  it('shows the file name', () => {
    render(<DiffView diff={TEXT_DIFF} />)
    expect(screen.getByText('first-post.md')).toBeInTheDocument()
  })

  it('says "Image changed" for a binary image, with thumbnails', () => {
    render(
      <DiffView
        diff={{
          path: 'src/assets/cover.png',
          binary: true,
          isImage: true,
          hunks: [],
        }}
        beforeSrc="asset://before.png"
        afterSrc="asset://after.png"
      />
    )
    expect(screen.getByText('Image changed')).toBeInTheDocument()
    expect(screen.getByAltText('Before')).toHaveAttribute(
      'src',
      'asset://before.png'
    )
    expect(screen.getByAltText('After')).toHaveAttribute(
      'src',
      'asset://after.png'
    )
    expect(screen.queryAllByTestId('diff-line')).toHaveLength(0)
  })

  it('says "New image" for an added image', () => {
    render(
      <DiffView
        diff={{ path: 'a.png', binary: true, isImage: true, hunks: [] }}
        change="untracked"
      />
    )
    expect(screen.getByText('New image')).toBeInTheDocument()
  })

  it('explains a binary file it cannot show', () => {
    render(
      <DiffView
        diff={{ path: 'font.woff2', binary: true, isImage: false, hunks: [] }}
      />
    )
    expect(screen.getByText(/can't be shown/)).toBeInTheDocument()
  })
})
