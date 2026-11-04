import { beforeEach, describe, expect, it } from 'vitest'
import type { CommandContext } from './types'
import { publishingCommands } from './publishing-commands'
import { getAllCommands } from './app-commands'
import { useGitStore } from '@/store/gitStore'
import { useUIStore } from '@/store/uiStore'

function context(showPublishingTools: boolean, projectPath: string | null) {
  return {
    currentFile: null,
    selectedCollection: null,
    collections: [],
    projectPath,
    globalSettings: { general: { showPublishingTools } },
  } as unknown as CommandContext
}

const command = (id: string) => {
  const found = publishingCommands.find(c => c.id === id)
  if (!found) throw new Error(`No command ${id}`)
  return found
}

describe('publishing commands', () => {
  beforeEach(() => {
    useGitStore.getState().reset()
    useUIStore.setState({ sidebarVisible: false })
  })

  it('offers Publish, Sync, History and New branch', () => {
    expect(publishingCommands.map(c => c.label)).toEqual([
      'Publish',
      'Sync',
      'History',
      'New Branch…',
    ])
  })

  it('hides them while the publishing tools are off or no project is open', () => {
    const ids = publishingCommands.map(c => c.id)
    const visible = (ctx: CommandContext) =>
      getAllCommands(ctx).filter(c => ids.includes(c.id))
    expect(visible(context(false, '/site'))).toHaveLength(0)
    expect(visible(context(true, null))).toHaveLength(0)
    expect(visible(context(true, '/site'))).toHaveLength(4)
  })

  it('Publish and Sync ask the Changes panel to run them', async () => {
    const seen: string[] = []
    const listener = (event: Event) => seen.push(event.type)
    window.addEventListener('git-publish', listener)
    window.addEventListener('git-sync', listener)
    await command('git-publish').execute(context(true, '/site'))
    await command('git-sync').execute(context(true, '/site'))
    window.removeEventListener('git-publish', listener)
    window.removeEventListener('git-sync', listener)
    expect(seen).toEqual(['git-publish', 'git-sync'])
    // Publish shows the Changes tab, so the writer sees what happens
    expect(useGitStore.getState().panelTab).toBe('changes')
    expect(useUIStore.getState().sidebarVisible).toBe(true)
  })

  it('History opens in the main area', async () => {
    await command('git-history').execute(context(true, '/site'))
    expect(useGitStore.getState().historyOpen).toBe(true)
  })

  it('New branch opens the dialog on the Changes tab', async () => {
    await command('git-new-branch').execute(context(true, '/site'))
    expect(useGitStore.getState().newBranchOpen).toBe(true)
    expect(useGitStore.getState().panelTab).toBe('changes')
  })
})
