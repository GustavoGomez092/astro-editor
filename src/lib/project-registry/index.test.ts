/**
 * Basic tests for the project registry system
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

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
    mockInvoke.mockResolvedValueOnce(null) // read_app_data_file_if_present (registry)
    mockInvoke.mockResolvedValueOnce(null) // read_app_data_file_if_present (global settings)
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
    mockInvoke.mockResolvedValueOnce(null) // read_app_data_file_if_present (project data)
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
   * that exist, and `unavailable` the ones that can't be checked (an unplugged
   * drive, no permission). Every other folder is missing
   */
  function fakeDisk(disk: {
    packages: Record<string, string>
    folders: Set<string>
    unavailable?: Set<string>
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
      if (command === 'read_app_data_file_if_present')
        return Promise.resolve(null)
      if (command === 'folder_states')
        return Promise.resolve(
          (a.paths as string[]).map(path =>
            disk.folders.has(path)
              ? 'present'
              : disk.unavailable?.has(path)
                ? 'unavailable'
                : 'missing'
          )
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

  it("doesn't move a project whose drive is unplugged to a copy of it", async () => {
    const disk = {
      packages: {
        '/Volumes/Content/site': 'astro-blog',
        '/Users/kevin/copy': 'astro-blog',
      } as Record<string, string>,
      folders: new Set(['/Volumes/Content/site']),
      unavailable: new Set<string>(),
    }
    fakeDisk(disk)
    await manager.initialize()
    const original = await manager.registerProject('/Volumes/Content/site')

    // The drive is unplugged, then a copy of the same template is opened
    disk.folders = new Set(['/Users/kevin/copy'])
    disk.unavailable = new Set(['/Volumes/Content/site'])
    const copy = await manager.registerProject('/Users/kevin/copy')

    expect(copy).not.toBe(original)
    expect(manager.getRegistry().projects[original]?.path).toBe(
      '/Volumes/Content/site'
    )
  })

  it("doesn't move a project whose folder can't be checked", async () => {
    const disk = {
      packages: { '/locked/site': 'astro-blog', '/new/site': 'astro-blog' },
      folders: new Set(['/locked/site']),
      unavailable: new Set<string>(),
    }
    fakeDisk(disk)
    await manager.initialize()
    const original = await manager.registerProject('/locked/site')

    // No permission to look in /locked any more
    disk.folders = new Set(['/new/site'])
    disk.unavailable = new Set(['/locked/site'])
    expect(await manager.registerProject('/new/site')).not.toBe(original)
    expect(manager.getRegistry().projects[original]?.path).toBe('/locked/site')
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

  it('removes a project from the list and sets its settings file aside', async () => {
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
    const calls = mockInvoke.mock.calls as [string, Record<string, string>][]
    const written = calls
      .filter(([command]) => command === 'write_app_data_file')
      .map(([, args]) => args.filePath)
    expect(written).toContain(
      '/mock/app/data/preferences/project-registry.json'
    )
    // Renamed, so a new project that gets the same id starts afresh
    const moves = calls.filter(([command]) => command === 'move_app_data_file')
    expect(moves).toHaveLength(1)
    expect(moves[0]![1].fromPath).toBe(
      '/mock/app/data/preferences/projects/b.json'
    )
    expect(moves[0]![1].toPath).toMatch(
      /^\/mock\/app\/data\/preferences\/projects\/b\.removed-[^/]+\.json$/
    )
  })

  it("removes a project whose settings file can't be set aside", async () => {
    fakeDisk({ packages: { '/sites/a': 'a' }, folders: new Set(['/sites/a']) })
    await manager.initialize()
    const a = await manager.registerProject('/sites/a')
    const fallback = vi.mocked(invoke).getMockImplementation()!
    vi.mocked(invoke).mockImplementation((command, args) =>
      command === 'move_app_data_file'
        ? // oxlint-disable-next-line typescript/prefer-promise-reject-errors
          Promise.reject('No such file')
        : fallback(command, args)
    )

    await manager.removeProject(a)

    expect(manager.getRegistry().projects).toEqual({})
  })

  it('keeps the Dev command override until it is cleared', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockImplementation(command => {
      if (command === 'get_app_data_dir')
        return Promise.resolve('/mock/app/data')
      if (command === 'read_file_content')
        return Promise.resolve(JSON.stringify({ name: 'site' }))
      if (command === 'read_app_data_file_if_present')
        return Promise.resolve(null)
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

  describe('remembering the open entry', () => {
    const registryWrites = () =>
      mockInvoke.mock.calls
        .filter(([command]) => command === 'write_app_data_file')
        .map(([, args]) => args as { filePath: string; content: string })
        .filter(a => a.filePath.endsWith('project-registry.json'))

    async function siteWithRegistry() {
      fakeDisk({
        packages: { '/sites/a': 'a' },
        folders: new Set(['/sites/a']),
      })
      await manager.initialize()
      const id = await manager.registerProject('/sites/a')
      vi.useFakeTimers()
      mockInvoke.mockClear()
      return id
    }

    afterEach(() => vi.useRealTimers())

    it('writes once, a second after the last change, and reads the pending value meanwhile', async () => {
      const id = await siteWithRegistry()

      manager.setLastOpenFile(id, 'src/content/blog/one.md')
      manager.setLastOpenFile(id, 'src/content/blog/two.md')
      expect(manager.getLastOpenFile(id)).toBe('src/content/blog/two.md')
      expect(registryWrites()).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(1100)

      expect(registryWrites()).toHaveLength(1)
      expect(registryWrites()[0]!.content).toContain('src/content/blog/two.md')
      expect(manager.getRegistry().projects[id]?.lastFile).toBe(
        'src/content/blog/two.md'
      )
    })

    it('does not change what is in memory until the save worked, and retries later', async () => {
      const id = await siteWithRegistry()
      const working = vi.mocked(invoke).getMockImplementation()!
      vi.mocked(invoke).mockImplementation((command, args) =>
        command === 'write_app_data_file'
          ? // oxlint-disable-next-line typescript/prefer-promise-reject-errors
            Promise.reject('disk full')
          : working(command, args)
      )

      manager.setLastOpenFile(id, 'a.md')
      await vi.advanceTimersByTimeAsync(1100)
      expect(manager.getRegistry().projects[id]?.lastFile).toBeUndefined()
      // Still remembered for this session
      expect(manager.getLastOpenFile(id)).toBe('a.md')

      vi.mocked(invoke).mockImplementation(working)
      manager.setLastOpenFile(id, 'a.md')
      await vi.advanceTimersByTimeAsync(1100)
      expect(manager.getRegistry().projects[id]?.lastFile).toBe('a.md')
    })

    it('tries once more after five seconds when a write fails, then waits for the next change', async () => {
      const id = await siteWithRegistry()
      const working = vi.mocked(invoke).getMockImplementation()!
      let writes = 0
      vi.mocked(invoke).mockImplementation((command, args) => {
        if (command === 'write_app_data_file') {
          writes++
          return writes <= 2
            ? // oxlint-disable-next-line typescript/prefer-promise-reject-errors
              Promise.reject('disk full')
            : working(command, args)
        }
        return working(command, args)
      })

      manager.setLastOpenFile(id, 'a.md')
      await vi.advanceTimersByTimeAsync(1100)
      expect(writes).toBe(1)
      await vi.advanceTimersByTimeAsync(5100)
      expect(writes).toBe(2)
      // The retry failed too: nothing more until something changes
      await vi.advanceTimersByTimeAsync(20_000)
      expect(writes).toBe(2)

      manager.setLastOpenFile(id, 'b.md')
      await vi.advanceTimersByTimeAsync(1100)
      expect(manager.getRegistry().projects[id]?.lastFile).toBe('b.md')
    })

    it('writes at once when asked to flush', async () => {
      const id = await siteWithRegistry()
      manager.setLastOpenFile(id, 'a.md')

      await manager.flushLastFiles()

      expect(registryWrites()).toHaveLength(1)
      expect(manager.getRegistry().projects[id]?.lastFile).toBe('a.md')
      // The timer no longer fires a second write
      await vi.advanceTimersByTimeAsync(1100)
      expect(registryWrites()).toHaveLength(1)
    })

    it('ignores an entry already stored, and a site that was removed', async () => {
      const id = await siteWithRegistry()
      manager.setLastOpenFile(id, 'a.md')
      await vi.advanceTimersByTimeAsync(1100)
      mockInvoke.mockClear()

      manager.setLastOpenFile(id, 'a.md')
      manager.setLastOpenFile('nope', 'b.md')
      await vi.advanceTimersByTimeAsync(1100)

      expect(registryWrites()).toHaveLength(0)
    })
  })

  it('shows the preview and publishing tools by default in this fork', async () => {
    setupInitializationMocks(mockInvoke)
    await manager.initialize()
    expect(manager.getGlobalSettings().general.showPublishingTools).toBe(true)
  })
})
