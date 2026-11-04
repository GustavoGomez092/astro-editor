import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  loadGlobalSettings,
  loadProjectData,
  loadProjectRegistry,
  saveGlobalSettings,
  saveProjectData,
} from './persistence'
import { DEFAULT_GLOBAL_SETTINGS } from './defaults'
import { toast } from '@/lib/toast'

vi.mock('@/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}))

const PREFS = '/data/preferences'

/**
 * A fake app data folder: path → contents. Writes and copies land in it.
 * `unreadable` files are there but can't be read; with `failCopy`, copies fail
 */
function fakeAppData(
  files: Record<string, string>,
  {
    unreadable = [],
    failCopy = false,
  }: { unreadable?: string[]; failCopy?: boolean } = {}
) {
  globalThis.mockTauri.invoke.mockImplementation(
    (command: string, args?: unknown) => {
      const a = (args ?? {}) as {
        filePath?: string
        content?: string
        fromPath?: string
        toPath?: string
      }
      if (command === 'get_app_data_dir') return Promise.resolve('/data')
      if (command === 'read_app_data_file_if_present') {
        if (unreadable.includes(a.filePath!))
          // Tauri rejects with the command's error string
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors
          return Promise.reject("Couldn't read it: Operation not permitted")
        return Promise.resolve(files[a.filePath!] ?? null)
      }
      if (command === 'write_app_data_file') {
        files[a.filePath!] = a.content!
        return Promise.resolve(null)
      }
      if (command === 'copy_app_data_file') {
        if (failCopy)
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors
          return Promise.reject("Couldn't copy it: disk full")
        files[a.toPath!] = files[a.fromPath!] ?? '(unreadable bytes)'
        return Promise.resolve(null)
      }
      return Promise.resolve(null)
    }
  )
  return files
}

const brokenCopies = (files: Record<string, string>, name: string) =>
  Object.keys(files).filter(path =>
    new RegExp(`/${name}\\.broken-[^/]+\\.json$`).test(path)
  )

describe('unreadable preferences files', () => {
  beforeEach(() => {
    globalThis.mockTauri.reset()
    vi.mocked(toast.warning).mockClear()
  })

  it('keeps a global settings file that does not parse, and says so once', async () => {
    const files = fakeAppData({
      [`${PREFS}/global-settings.json`]: '{ "general": { oops',
    })

    const settings = await loadGlobalSettings()

    expect(settings).toEqual(DEFAULT_GLOBAL_SETTINGS)
    const copies = brokenCopies(files, 'global-settings')
    expect(copies).toHaveLength(1)
    expect(files[copies[0]!]).toBe('{ "general": { oops')
    expect(toast.warning).toHaveBeenCalledTimes(1)

    // The defaults replace it, so the next start doesn't report it again
    await loadGlobalSettings()
    expect(brokenCopies(files, 'global-settings')).toHaveLength(1)
    expect(toast.warning).toHaveBeenCalledTimes(1)
  })

  it('keeps a project file that does not parse, and says where', async () => {
    const files = fakeAppData({
      [`${PREFS}/projects/site.json`]: 'not json',
    })

    expect(await loadProjectData('site')).toBeNull()
    const copies = brokenCopies(files, 'site')
    expect(copies).toHaveLength(1)
    expect(copies[0]).toMatch(/^\/data\/preferences\/projects\//)
    expect(toast.warning).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast.warning).mock.calls[0]![1]?.description).toMatch(
      /kept as projects\/site\.broken-[^ ]+\.json in the preferences folder/
    )
  })

  it("keeps a copy of a file that's there but can't be read", async () => {
    const path = `${PREFS}/global-settings.json`
    const files = fakeAppData({ [path]: 'bytes' }, { unreadable: [path] })

    expect(await loadGlobalSettings()).toEqual(DEFAULT_GLOBAL_SETTINGS)

    expect(brokenCopies(files, 'global-settings')).toHaveLength(1)
    expect(toast.warning).toHaveBeenCalledTimes(1)
  })

  it("never writes over a broken file it couldn't keep a copy of", async () => {
    const path = `${PREFS}/global-settings.json`
    const files = fakeAppData({ [path]: '{ oops' }, { failCopy: true })

    expect(await loadGlobalSettings()).toEqual(DEFAULT_GLOBAL_SETTINGS)
    await saveGlobalSettings(DEFAULT_GLOBAL_SETTINGS)

    expect(files[path]).toBe('{ oops')
    expect(toast.warning).toHaveBeenCalledTimes(1)
    // Still broken, so it's reported again next time
    await loadGlobalSettings()
    expect(files[path]).toBe('{ oops')
    expect(toast.warning).toHaveBeenCalledTimes(2)
  })

  it("never writes over a project file it couldn't keep a copy of", async () => {
    const path = `${PREFS}/projects/site.json`
    const files = fakeAppData({ [path]: 'not json' }, { failCopy: true })

    expect(await loadProjectData('site')).toBeNull()
    await saveProjectData('site', {
      settings: { pathOverrides: {}, frontmatterMappings: {} },
      version: 2,
    })

    expect(files[path]).toBe('not json')
  })

  it('keeps a project list that does not parse', async () => {
    const files = fakeAppData({
      [`${PREFS}/project-registry.json`]: '{"projects": {',
    })

    const registry = await loadProjectRegistry()

    expect(registry.projects).toEqual({})
    expect(brokenCopies(files, 'project-registry')).toHaveLength(1)
    expect(toast.warning).toHaveBeenCalledTimes(1)
  })

  it('treats a missing file as new, without a warning', async () => {
    const files = fakeAppData({})

    expect(await loadProjectData('site')).toBeNull()
    await loadGlobalSettings()
    await loadProjectRegistry()

    expect(Object.keys(files).some(p => p.includes('.broken-'))).toBe(false)
    expect(toast.warning).not.toHaveBeenCalled()
  })
})
