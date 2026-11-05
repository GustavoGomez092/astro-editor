import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectRegistryManager } from '@/lib/project-registry'
import { waitForProjectReady } from '@/lib/projects/ready'
import { toast } from '@/lib/toast'
import { useProjectStore } from './projectStore'

/** A promise the test settles by hand */
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const calls = (command: string) =>
  globalThis.mockTauri.invoke.mock.calls.filter(c => c[0] === command)

describe('opening and closing a site at the same time', () => {
  const unlisteners: ReturnType<typeof vi.fn>[] = []

  beforeEach(() => {
    globalThis.mockTauri.reset()
    globalThis.mockTauri.invoke.mockResolvedValue(null)
    unlisteners.length = 0
    globalThis.mockTauri.listen.mockImplementation(() => {
      const unlisten = vi.fn()
      unlisteners.push(unlisten)
      return Promise.resolve(unlisten)
    })
    useProjectStore.setState({
      projectPath: null,
      currentProjectId: null,
      currentProjectSettings: null,
      _watcherId: null,
    })
    vi.spyOn(toast, 'warning').mockImplementation(() => 0)
  })

  it('does not open a site that was closed (Home) while it was opening', async () => {
    const registering = deferred<string>()
    // oxlint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(projectRegistryManager.registerProject).mockReturnValueOnce(
      registering.promise
    )

    useProjectStore.getState().setProject('/s/a')
    await settle()
    await useProjectStore.getState().closeProject()
    registering.resolve('a')
    await settle()

    expect(useProjectStore.getState().projectPath).toBeNull()
    expect(calls('start_watching_project_with_content_dir')).toHaveLength(0)
  })

  it('does not open the site being switched to after Home closed the old one', async () => {
    useProjectStore.setState({ projectPath: '/s/b', currentProjectId: 'b' })
    const loading = deferred<never>()
    // oxlint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(projectRegistryManager.getEffectiveSettings).mockReturnValueOnce(
      loading.promise
    )

    useProjectStore.getState().setProject('/s/a')
    await settle()
    await useProjectStore.getState().closeProject()
    loading.resolve({} as never)
    await settle()

    expect(useProjectStore.getState().projectPath).toBeNull()
  })

  it('a newer open wins over an older one still loading', async () => {
    const first = deferred<string>()
    // oxlint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(projectRegistryManager.registerProject).mockReturnValueOnce(
      first.promise
    )

    useProjectStore.getState().setProject('/s/a')
    await settle()
    useProjectStore.getState().setProject('/s/b')
    await settle()
    first.resolve('a')
    await settle()

    expect(useProjectStore.getState().projectPath).toBe('/s/b')
  })

  it('stops a watcher that was still starting when the site closed', async () => {
    const started = deferred<unknown>()
    globalThis.mockTauri.invoke.mockImplementation((command: string) =>
      command === 'start_watching_project_with_content_dir'
        ? started.promise
        : Promise.resolve(null)
    )
    vi.mocked(toast.warning).mockClear()

    useProjectStore.getState().setProject('/s/a')
    await vi.waitFor(() =>
      expect(calls('start_watching_project_with_content_dir')).toHaveLength(1)
    )
    await useProjectStore.getState().closeProject()
    started.resolve(5)
    await settle()

    // Everything it registered is undone, and Rust is told to stop after it started
    expect(unlisteners.length).toBeGreaterThan(0)
    for (const unlisten of unlisteners) expect(unlisten).toHaveBeenCalled()
    const order = globalThis.mockTauri.invoke.mock.calls.map(c => c[0])
    expect(order.lastIndexOf('stop_watching_project')).toBeGreaterThan(
      order.indexOf('start_watching_project_with_content_dir')
    )
    expect(useProjectStore.getState()._unlistenFileChanged).toBeNull()
    // Closing before anything was registered, and the undo, raise no alarm
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('a late undo of an older start leaves the watcher of the same site opened again', async () => {
    const firstStart = deferred<unknown>()
    let starts = 0
    globalThis.mockTauri.invoke.mockImplementation((command: string) => {
      if (command === 'start_watching_project_with_content_dir') {
        starts++
        return starts === 1 ? firstStart.promise : Promise.resolve(6)
      }
      return Promise.resolve(null)
    })

    useProjectStore.getState().setProject('/s/a')
    await vi.waitFor(() => expect(starts).toBe(1))
    await useProjectStore.getState().closeProject()
    useProjectStore.getState().setProject('/s/a')
    await vi.waitFor(() =>
      expect(useProjectStore.getState()._watcherId).toBe(6)
    )
    const liveListeners = unlisteners.length
    firstStart.resolve(5)
    await settle()

    // Only the first start was stopped, named by its id
    const stops = calls('stop_watching_project')
    expect(
      stops.filter(c => (c[1] as { watcherId: number | null }).watcherId === 5)
    ).toHaveLength(1)
    expect(
      stops.every(c => (c[1] as { projectPath: string }).projectPath === '/s/a')
    ).toBe(true)
    expect(
      stops.some(c => (c[1] as { watcherId: unknown }).watcherId === 6)
    ).toBe(false)
    // The second site's watcher is registered and still listening
    expect(useProjectStore.getState()._watcherId).toBe(6)
    expect(useProjectStore.getState().projectPath).toBe('/s/a')
    for (const unlisten of unlisteners.slice(0, liveListeners)) {
      expect(unlisten).not.toHaveBeenCalled()
    }
  })

  it('starts only one watcher when the same site is opened twice in a row', async () => {
    useProjectStore.getState().setProject('/s/b')
    useProjectStore.getState().setProject('/s/b')
    await settle()

    expect(calls('start_watching_project_with_content_dir')).toHaveLength(1)
    expect(useProjectStore.getState().projectPath).toBe('/s/b')
  })

  it('does not warn about a watcher failing to start for an open that was cancelled', async () => {
    const started = deferred<never>()
    globalThis.mockTauri.invoke.mockImplementation((command: string) =>
      command === 'start_watching_project_with_content_dir'
        ? started.promise
        : Promise.resolve(null)
    )
    vi.mocked(toast.warning).mockClear()

    useProjectStore.getState().setProject('/s/a')
    await vi.waitFor(() =>
      expect(calls('start_watching_project_with_content_dir')).toHaveLength(1)
    )
    await useProjectStore.getState().closeProject()
    started.promise.catch(() => {})
    globalThis.mockTauri.invoke.mockImplementation(() => Promise.resolve(null))
    started.resolve(undefined as never)
    await settle()

    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('waitForProjectReady gives up when the open is cancelled', async () => {
    const registering = deferred<string>()
    // oxlint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(projectRegistryManager.registerProject).mockReturnValueOnce(
      registering.promise
    )
    useProjectStore.getState().setProject('/s/a')
    const ready = waitForProjectReady('/s/a')

    await useProjectStore.getState().closeProject()

    expect(await ready).toBe(false)
    registering.resolve('a')
  })
})
