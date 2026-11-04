import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CommitDetails } from './CommitDetails'
import type { CommitDetails as Details } from '@/lib/git/types'

const DETAILS: Details = {
  id: 'a1b2c3d4e5f6',
  shortId: 'a1b2c3d',
  parents: ['f0f0f0f'],
  summary: 'Update About page',
  message: 'Update About page\n\nNew portrait and a shorter bio.',
  authorName: 'Kevin Robinson',
  authorEmail: 'kevin@example.com',
  time: 1_793_000_000,
  refs: [],
  files: [
    { path: 'src/content/pages/about.md', oldPath: null, change: 'modified' },
    { path: 'src/assets/portrait.jpg', oldPath: null, change: 'added' },
  ],
}

describe('CommitDetails', () => {
  it('shows the message, author and files', () => {
    render(<CommitDetails details={DETAILS} />)
    expect(screen.getByText('Update About page')).toBeInTheDocument()
    expect(
      screen.getByText('New portrait and a shorter bio.')
    ).toBeInTheDocument()
    expect(screen.getByText(/Kevin Robinson/)).toBeInTheDocument()
    expect(screen.getByText('about.md')).toBeInTheDocument()
    expect(screen.getByText('portrait.jpg')).toBeInTheDocument()
  })

  it('opens a file diff on click', async () => {
    const onSelectFile = vi.fn()
    render(<CommitDetails details={DETAILS} onSelectFile={onSelectFile} />)
    await userEvent.click(screen.getByText('about.md'))
    expect(onSelectFile).toHaveBeenCalledWith('src/content/pages/about.md')
  })
})
