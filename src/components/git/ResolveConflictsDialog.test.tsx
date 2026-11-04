import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ConflictFile } from '@/lib/bindings'
import { ResolveConflictsDialog } from './ResolveConflictsDialog'

const FILES: ConflictFile[] = [
  {
    path: 'src/content/team/andrew.md',
    mine: '---\ntitle: Andrew Dyk\nrole: Founder\n---\n',
    theirs: '---\ntitle: Andrew Dyk\nrole: Director\n---\n',
    binary: false,
  },
  {
    path: 'src/assets/andrew.jpg',
    mine: null,
    theirs: null,
    binary: true,
  },
]

function renderDialog(
  props: Partial<Parameters<typeof ResolveConflictsDialog>[0]> = {}
) {
  const onCombine = vi.fn()
  render(
    <ResolveConflictsDialog
      open
      onOpenChange={vi.fn()}
      files={FILES}
      titles={new Map([['src/content/team/andrew.md', 'Andrew Dyk']])}
      onGitHub
      onCombine={onCombine}
      pending={false}
      {...props}
    />
  )
  return { onCombine }
}

describe('ResolveConflictsDialog', () => {
  it('shows each entry by title with both versions side by side', () => {
    renderDialog()
    const entry = screen.getByRole('group', { name: 'Andrew Dyk' })
    expect(within(entry).getByText(/role: Founder/)).toBeInTheDocument()
    expect(within(entry).getByText(/role: Director/)).toBeInTheDocument()
    expect(within(entry).getByText('Your version')).toBeInTheDocument()
    expect(within(entry).getByText("GitHub's version")).toBeInTheDocument()
    const image = screen.getByRole('group', { name: 'andrew.jpg' })
    expect(within(image).getAllByText('Image')).toHaveLength(2)
  })

  it('combines once every file has a choice', async () => {
    const { onCombine } = renderDialog()
    const combine = screen.getByRole('button', { name: 'Combine and publish' })
    expect(combine).toBeDisabled()

    const entry = screen.getByRole('group', { name: 'Andrew Dyk' })
    await userEvent.click(
      within(entry).getByRole('button', { name: 'Keep mine' })
    )
    expect(combine).toBeDisabled()
    const image = screen.getByRole('group', { name: 'andrew.jpg' })
    await userEvent.click(
      within(image).getByRole('button', { name: "Use GitHub's" })
    )
    expect(combine).toBeEnabled()
    await userEvent.click(combine)
    expect(onCombine).toHaveBeenCalledWith([
      { path: 'src/content/team/andrew.md', choice: 'mine' },
      { path: 'src/assets/andrew.jpg', choice: 'theirs' },
    ])
  })

  it('says "the other version" when the remote is not GitHub', () => {
    renderDialog({ onGitHub: false })
    expect(
      screen.getAllByRole('button', { name: 'Use the other version' })
    ).toHaveLength(2)
    expect(screen.queryByText(/GitHub/)).toBeNull()
  })
})
