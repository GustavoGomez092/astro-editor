/**
 * Basic tests for the project registry system
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Unmock the project-registry module for these tests
vi.unmock('.')
vi.unmock('./defaults')
vi.unmock('./persistence')
vi.unmock('./utils')

import { invoke } from '@tauri-apps/api/core'
import { ProjectRegistryManager } from '.'
import { DEFAULT_PROJECT_SETTINGS } from './defaults'

// Mock Tauri invoke for testing
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

describe('Project Registry System', () => {
  let manager: ProjectRegistryManager
  let mockInvoke: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()

    // Import the mocked invoke function
    const { invoke } = await import('@tauri-apps/api/core')
    mockInvoke = invoke as ReturnType<typeof vi.fn>

    // Create fresh manager instance for each test
    manager = new ProjectRegistryManager()
  })

  /**
   * Helper to set up the initialization mock sequence
   * These mocks handle the initial file system calls during manager.initialize()
   */
  function setupInitializationMocks(mockInvoke: ReturnType<typeof vi.fn>) {
    mockInvoke.mockResolvedValueOnce('/mock/app/data') // get_app_data_dir
    mockInvoke.mockRejectedValueOnce(new Error('File not found')) // read_file_content (registry)
    mockInvoke.mockRejectedValueOnce(new Error('File not found')) // read_file_content (global settings)
  }

  it('should initialize with default settings', async () => {
    setupInitializationMocks(mockInvoke)

    await manager.initialize()

    const globalSettings = manager.getGlobalSettings()
    const registry = manager.getRegistry()

    // Check structure instead of exact equality
    expect(globalSettings).toBeDefined()
    expect(globalSettings.general).toBeDefined()
    expect(globalSettings.general.ideCommand).toBe('')
    expect(globalSettings.general.theme).toBe('system')
    expect(globalSettings.general.autoSaveDelay).toBe(2) // Check auto-save delay default
    expect(globalSettings.appearance).toBeDefined()
    expect(globalSettings.appearance.headingColor).toBeDefined()
    expect(globalSettings.appearance.headingColor.light).toBe('#191919') // Check heading color defaults
    expect(globalSettings.appearance.headingColor.dark).toBe('#cccccc')
    expect(globalSettings.version).toBe(2)

    expect(registry.projects).toEqual({})
    expect(registry.lastOpenedProject).toBeNull()
  })

  it('should handle project registration', async () => {
    // Initialize manager first
    setupInitializationMocks(mockInvoke)

    await manager.initialize()

    // Mock project discovery
    const mockProjectPath = '/Users/test/projects/test-project' // Use test-project as folder name
    const mockPackageJson = JSON.stringify({ name: 'test-project' })

    // Mock the project registration calls
    mockInvoke.mockResolvedValueOnce(mockPackageJson) // read_file_content (package.json)
    mockInvoke.mockResolvedValueOnce('/mock/app/data') // get_app_data_dir for save
    mockInvoke.mockResolvedValueOnce(undefined) // create_directory (preferences)
    mockInvoke.mockResolvedValueOnce(undefined) // create_directory (projects)
    mockInvoke.mockResolvedValueOnce('/mock/app/data') // get_app_data_dir for save path
    mockInvoke.mockResolvedValueOnce(undefined) // write_app_data_file (save registry)

    const projectId = await manager.registerProject(mockProjectPath)

    // The ID will be based on the path since package.json read is failing
    expect(projectId).toBeTruthy()
    expect(manager.getRegistry().projects[projectId]).toBeDefined()
    expect(manager.getRegistry().projects[projectId]?.name).toBe('test-project')
    expect(manager.getRegistry().projects[projectId]?.path).toBe(
      mockProjectPath
    )
    expect(manager.getRegistry().lastOpenedProject).toBe(projectId)
  })

  it('should provide effective settings combining global and project settings', async () => {
    // Initialize manager
    setupInitializationMocks(mockInvoke)

    await manager.initialize()

    // Register a project
    const mockProjectPath = '/mock/project/path'
    const mockPackageJson = JSON.stringify({ name: 'test-project' })

    mockInvoke.mockResolvedValueOnce(mockPackageJson) // read_file_content (package.json)
    mockInvoke.mockResolvedValueOnce(undefined) // write_app_data_file (save registry)

    const projectId = await manager.registerProject(mockProjectPath)

    // Mock loading project data (no project-specific settings)
    mockInvoke.mockRejectedValueOnce(new Error('File not found')) // read_file_content (project data)
    mockInvoke.mockResolvedValueOnce(undefined) // write_app_data_file (save project data)

    const effectiveSettings = await manager.getEffectiveSettings(projectId)

    // Should return default settings plus collections array
    expect(effectiveSettings).toEqual({
      ...DEFAULT_PROJECT_SETTINGS,
      collections: [],
    })
  })

  /**
   * A fake disk for registering projects: `packages` maps a folder to its
   * package.json name (absent: no package.json), `folders` lists the folders
   * that exist
   */
  function fakeDisk(disk: {
    packages: Record<string, string>
    folders: Set<string>
  }) {
    vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
      const a = (args ?? {}) as Record<string, unknown>
      if (command === 'get_app_data_dir')
        return Promise.resolve('/mock/app/data')
      if (command === 'read_file_content') {
        const folder = String(a.projectRoot)
        const name = disk.packages[folder]
        return name === undefined
          ? Promise.reject(new Error('File not found'))
          : Promise.resolve(JSON.stringify({ name }))
      }
      if (command === 'read_app_data_file')
        return Promise.reject(new Error('File not found'))
      if (command === 'folders_exist')
        return Promise.resolve(
          (a.paths as string[]).map(path => disk.folders.has(path))
        )
      return Promise.resolve(undefined)
    })
  }

  it('follows a project whose folder moved', async () => {
    const disk = {
      packages: { '/old/site': 'my-site' } as Record<string, string>,
      folders: new Set(['/old/site']),
    }
    fakeDisk(disk)
    await manager.initialize()
    const id = await manager.registerProject('/old/site')

    // Moved: the old folder is gone, the new one has the same package name
    disk.folders = new Set(['/new/site'])
    disk.packages = { '/new/site': 'my-site' }
    expect(await manager.registerProject('/new/site')).toBe(id)
    expect(manager.getRegistry().projects[id]?.path).toBe('/new/site')
    expect(Object.keys(manager.getRegistry().projects)).toHaveLength(1)
  })

  it('keeps two copies of one template apart', async () => {
    const disk = {
      packages: { '/sites/a': 'astro-blog', '/sites/b': 'astro-blog' },
      folders: new Set(['/sites/a', '/sites/b']),
    }
    fakeDisk(disk)
    await manager.initialize()
    const a = await manager.registerProject('/sites/a')
    const b = await manager.registerProject('/sites/b')

    expect(b).not.toBe(a)
    expect(manager.getRegistry().projects[a]?.path).toBe('/sites/a')
    expect(manager.getRegistry().projects[b]?.path).toBe('/sites/b')
    // Opening the first again finds it by its path
    expect(await manager.registerProject('/sites/a')).toBe(a)
    expect(manager.getRegistry().projects[a]?.path).toBe('/sites/a')
  })

  it('never matches a moved project on its folder name alone', async () => {
    const disk = {
      packages: {} as Record<string, string>,
      folders: new Set(['/work/notes']),
    }
    fakeDisk(disk)
    await manager.initialize()
    const first = await manager.registerProject('/work/notes')

    // The first folder is gone, and another folder with the same name and
    // no package.json is opened: an unrelated project
    disk.folders = new Set(['/home/notes'])
    const second = await manager.registerProject('/home/notes')
    expect(second).not.toBe(first)
    expect(manager.getRegistry().projects[first]?.path).toBe('/work/notes')
  })

  it('removes a project from the list without touching its settings file', async () => {
    fakeDisk({
      packages: { '/sites/a': 'a', '/sites/b': 'b' },
      folders: new Set(['/sites/a', '/sites/b']),
    })
    await manager.initialize()
    const a = await manager.registerProject('/sites/a')
    const b = await manager.registerProject('/sites/b')
    mockInvoke.mockClear()

    await manager.removeProject(b)

    expect(Object.keys(manager.getRegistry().projects)).toEqual([a])
    expect(manager.getLastOpenedProjectId()).toBeNull()
    const written = mockInvoke.mock.calls
      .filter(([command]) => command === 'write_app_data_file')
      .map(([, args]) => (args as { filePath: string }).filePath)
    expect(written).toContain(
      '/mock/app/data/preferences/project-registry.json'
    )
    expect(written.some(path => path.includes('/projects/b'))).toBe(false)
  })

  it('keeps the Dev command override until it is cleared', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockImplementation(command => {
      if (command === 'get_app_data_dir')
        return Promise.resolve('/mock/app/data')
      if (command === 'read_file_content')
        return Promise.resolve(JSON.stringify({ name: 'site' }))
      if (command === 'read_app_data_file')
        return Promise.reject(new Error('File not found'))
      return Promise.resolve(undefined)
    })
    await manager.initialize()
    const projectId = await manager.registerProject('/Users/test/site')

    await manager.updateProjectSettings(projectId, {
      devCommand: 'npm run start',
    })
    expect((await manager.getEffectiveSettings(projectId)).devCommand).toBe(
      'npm run start'
    )

    await manager.updateProjectSettings(projectId, { devCommand: null })
    expect(
      (await manager.getEffectiveSettings(projectId)).devCommand
    ).toBeUndefined()
    const saved = mockInvoke.mock.calls
      .filter(([command]) => command === 'write_app_data_file')
      .map(([, args]) => (args as { content: string }).content)
      .at(-1)
    expect(saved).not.toContain('devCommand')
  })

  it('shows the preview and publishing tools by default in this fork', async () => {
    setupInitializationMocks(mockInvoke)
    await manager.initialize()
    expect(manager.getGlobalSettings().general.showPublishingTools).toBe(true)
  })
})
