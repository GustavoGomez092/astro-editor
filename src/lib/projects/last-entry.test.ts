import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectRegistryManager } from '@/lib/project-registry'
import { useEditorStore } from '@/store/editorStore'
import { useProjectStore } from '@/store/projectStore'
import {
  absoluteInProject,
  relativeToProject,
  rememberLastEntry,
  reopenLastEntry,
} from './last-entry'

const meta = (id: string, path: string, lastFile?: string) => ({
  id,
  name: id,
  path,
  lastOpened: '2026-11-01T10:00:00Z',
  created: '2026-11-01T10:00:00Z',
  lastFile,
})

function setRegistry(projects: ReturnType<typeof meta>[]) {
  // oxlint-disable-next-line @typescript-eslint/unbound-method
  vi.mocked(projectRegistryManager.getLastOpenFile).mockImplementation(
    id => projects.find(p => p.id === id)?.lastFile
  )
  // oxlint-disable-next-line @typescript-eslint/unbound-method
  vi.mocked(projectRegistryManager.getRegistry).mockReturnValue({
    projects: Object.fromEntries(projects.map(p => [p.id, p])),
    lastOpenedProject: null,
    version: 2,
  })
}

const entry = (path: string) => ({
  id: path,
  path,
  name: 'x',
  extension: 'md',
  collection: 'blog',
  last_modified: null,
  frontmatter: null,
})

describe('paths', () => {
  it('stores a path relative to the project and rebuilds it', () => {
    expect(relativeToProject('/s/a', '/s/a/src/content/blog/x.md')).toBe(
      'src/content/blog/x.md'
    )
    expect(relativeToProject('/s/a/', '/s/a/src/x.md')).toBe('src/x.md')
    expect(relativeToProject('/s/a', '/s/other/x.md')).toBeNull()
    expect(relativeToProject('/s/a', '/s/ab/x.md')).toBeNull()
    expect(absoluteInProject('/s/a/', 'src/x.md')).toBe('/s/a/src/x.md')
  })

  it('handles Windows separators', () => {
    expect(relativeToProject('C:\\sites\\a', 'C:\\sites\\a\\src\\x.md')).toBe(
      'src/x.md'
    )
    expect(absoluteInProject('C:\\sites\\a\\', 'src/x.md')).toBe(
      'C:/sites/a/src/x.md'
    )
  })
})

describe('remembering and reopening the last entry', () => {
  const openFile = vi.fn()

  beforeEach(() => {
    globalThis.mockTauri.reset()
    openFile.mockClear()
    useEditorStore.setState({ openFile })
    useProjectStore.setState({ currentProjectSettings: null })
    // The registry is mocked globally (src/test/setup.ts)
    // oxlint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(projectRegistryManager.setLastOpenFile).mockClear()
    // The file exists unless a test says otherwise
    globalThis.mockTauri.invoke.mockImplementation(
      (command: string, args?: unknown) =>
        Promise.resolve(
          command === 'resolve_file_entry'
            ? entry((args as { filePath: string }).filePath)
            : null
        )
    )
  })

  it('records the entry relative to its own project', async () => {
    setRegistry([meta('a', '/s/a'), meta('b', '/s/b')])

    await rememberLastEntry('/s/b', '/s/b/src/content/blog/hi.md')

    // oxlint-disable-next-line @typescript-eslint/unbound-method
    expect(projectRegistryManager.setLastOpenFile).toHaveBeenCalledWith(
      'b',
      'src/content/blog/hi.md'
    )
  })

  it('records the entry of a project opened through a link, by its real path', async () => {
    setRegistry([meta('a', '/link/a')])
    globalThis.mockTauri.invoke.mockImplementation((command: string) =>
      Promise.resolve(command === 'canonical_path' ? '/real/a' : null)
    )

    await rememberLastEntry('/link/a', '/real/a/src/content/blog/hi.md')

    // oxlint-disable-next-line @typescript-eslint/unbound-method
    expect(projectRegistryManager.setLastOpenFile).toHaveBeenCalledWith(
      'a',
      'src/content/blog/hi.md'
    )
  })

  it('records nothing for a file outside the project', async () => {
    setRegistry([meta('a', '/s/a')])
    globalThis.mockTauri.invoke.mockResolvedValue('/s/a')

    await rememberLastEntry('/s/a', '/elsewhere/x.md')

    // oxlint-disable-next-line @typescript-eslint/unbound-method
    expect(projectRegistryManager.setLastOpenFile).not.toHaveBeenCalled()
  })

  it('reopens the remembered entry', async () => {
    setRegistry([meta('a', '/s/a', 'src/content/blog/hi.md')])

    expect(await reopenLastEntry('/s/a')).toBe(true)

    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/s/a/src/content/blog/hi.md' })
    )
  })

  it('opens nothing when the file is gone', async () => {
    setRegistry([meta('a', '/s/a', 'src/content/blog/gone.md')])
    globalThis.mockTauri.invoke.mockResolvedValue(null)

    expect(await reopenLastEntry('/s/a')).toBe(false)

    expect(openFile).not.toHaveBeenCalled()
  })

  it('opens nothing when the site has no remembered entry or it fails', async () => {
    setRegistry([meta('a', '/s/a')])
    expect(await reopenLastEntry('/s/a')).toBe(false)

    setRegistry([meta('a', '/s/a', 'x.md')])
    globalThis.mockTauri.invoke.mockRejectedValue(new Error('boom'))
    expect(await reopenLastEntry('/s/a')).toBe(false)
    expect(openFile).not.toHaveBeenCalled()
  })

  it('keeps each site’s own entry when switching between two', async () => {
    setRegistry([
      meta('a', '/s/a', 'src/content/blog/one.md'),
      meta('b', '/s/b', 'src/content/notes/two.md'),
    ])

    await reopenLastEntry('/s/a')
    await reopenLastEntry('/s/b')
    await reopenLastEntry('/s/a')

    expect(
      openFile.mock.calls.map(c => (c[0] as { path: string }).path)
    ).toEqual([
      '/s/a/src/content/blog/one.md',
      '/s/b/src/content/notes/two.md',
      '/s/a/src/content/blog/one.md',
    ])
  })
})
