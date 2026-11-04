import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '@/test/test-utils'
import { useGitStore } from '@/store/gitStore'
import { OpenFromGitHubDialog } from './OpenFromGitHubDialog'

vi.mock('@/lib/bindings', () => ({
  commands: {
    githubAuthStatus: vi.fn(() => new Promise(() => {})),
    githubListRepos: vi.fn(() => new Promise(() => {})),
  },
}))
vi.mock('@tauri-apps/api/path', () => ({
  homeDir: () => Promise.resolve('/Users/k'),
}))

describe('OpenFromGitHubDialog', () => {
  beforeEach(() => {
    useGitStore.setState({ openFromGitHubOpen: true, cloneInProgress: false })
  })

  it('closes with Escape when nothing is downloading', async () => {
    renderWithProviders(<OpenFromGitHubDialog />)
    await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    expect(useGitStore.getState().openFromGitHubOpen).toBe(false)
  })

  it("can't be closed while a site is downloading, so the result isn't lost", async () => {
    useGitStore.setState({ cloneInProgress: true })
    renderWithProviders(<OpenFromGitHubDialog />)
    await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(useGitStore.getState().openFromGitHubOpen).toBe(true)
  })
})
