import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ConflictFile } from '@/lib/bindings'
import { ResolveConflictsDialog } from './ResolveConflictsDialog'

const ANDREW: ConflictFile = {
  path: 'src/content/team/andrew.md',
  mine: '---\ntitle: Andrew Dyk\nrole: Founder\n---\n\nHe started the studio.\n',
  theirs:
    '---\ntitle: Andrew Dyk\nrole: Director\n---\n\nHe started the studio.\n',
  binary: false,
}
const PHOTO: ConflictFile = {
  path: 'src/assets/andrew.jpg',
  mine: null,
  theirs: null,
  binary: true,
}

function renderDialog(
  props: Partial<Parameters<typeof ResolveConflictsDialog>[0]> = {}
) {
  const onCombine = vi.fn()
  const view = render(
    <ResolveConflictsDialog
      open
      onOpenChange={vi.fn()}
      files={[ANDREW, PHOTO]}
      titles={new Map([[ANDREW.path, 'Andrew Dyk']])}
      onGitHub
      onCombine={onCombine}
      pending={false}
      message={null}
      {...props}
    />
  )
  return { onCombine, ...view }
}

describe('ResolveConflictsDialog', () => {
  it('says what differs in plain words, by field, with both values', () => {
    renderDialog()
    const entry = screen.getByRole('group', { name: 'Andrew Dyk' })
    const row = within(entry).getByRole('row', { name: /Role/ })
    expect(row).toHaveTextContent('Founder')
    expect(row).toHaveTextContent('Director')
    expect(within(entry).getByText('Your version')).toBeInTheDocument()
    expect(within(entry).getByText("GitHub's version")).toBeInTheDocument()
    // The raw YAML isn't the main view
    expect(within(entry).queryByText(/role: Founder/)).toBeNull()
    const image = screen.getByRole('group', { name: 'andrew.jpg' })
    expect(within(image).getAllByText('Image')).toHaveLength(2)
  })

  it('shows the full versions on request, changed lines marked', async () => {
    renderDialog()
    const entry = screen.getByRole('group', { name: 'Andrew Dyk' })
    await userEvent.click(
      within(entry).getByRole('button', { name: 'Show full versions' })
    )
    const changed = within(entry)
      .getAllByText(/role: /)
      .map(line => line.closest('[data-changed]')?.getAttribute('data-changed'))
    expect(changed).toEqual(['true', 'true'])
    expect(
      within(entry)
        .getAllByText('He started the studio.')[0]!
        .closest('[data-changed]')
        ?.getAttribute('data-changed')
    ).toBe('false')
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
      { path: ANDREW.path, choice: 'mine' },
      { path: PHOTO.path, choice: 'theirs' },
    ])
  })

  it('starts the choices again when the list changes', async () => {
    const { rerender } = renderDialog()
    const entry = screen.getByRole('group', { name: 'Andrew Dyk' })
    await userEvent.click(
      within(entry).getByRole('button', { name: 'Keep mine' })
    )
    const edited = { ...ANDREW, mine: ANDREW.mine!.replace('Founder', 'Owner') }
    rerender(
      <ResolveConflictsDialog
        open
        onOpenChange={vi.fn()}
        files={[edited, PHOTO]}
        titles={new Map([[ANDREW.path, 'Andrew Dyk']])}
        onGitHub
        onCombine={vi.fn()}
        pending={false}
        message={null}
      />
    )
    const fresh = screen.getByRole('group', { name: 'Andrew Dyk' })
    expect(within(fresh).getByRole('row', { name: /Role/ })).toHaveTextContent(
      'Owner'
    )
    expect(
      within(fresh).getByRole('button', { name: 'Keep mine' })
    ).toHaveAttribute('aria-pressed', 'false')
  })

  it('shows what stopped it inside the dialog', () => {
    renderDialog({ message: 'Your edits to “Andrew Dyk” would be lost.' })
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your edits to “Andrew Dyk” would be lost.'
    )
  })

  it('says "the other version" when the remote is not GitHub', () => {
    renderDialog({ onGitHub: false })
    expect(
      screen.getAllByRole('button', { name: 'Use the other version' })
    ).toHaveLength(2)
    expect(screen.queryByText(/GitHub/)).toBeNull()
  })
})
