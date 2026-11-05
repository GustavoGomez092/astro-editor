import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectRegistryManager } from '@/lib/project-registry'
import { waitForProjectReady } from '@/lib/projects/ready'
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
    })
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

    useProjectStore.getState().setProject('/s/a')
    await vi.waitFor(() =>
      expect(calls('start_watching_project_with_content_dir')).toHaveLength(1)
    )
    await useProjectStore.getState().closeProject()
    started.resolve(null)
    await settle()

    // Everything it registered is undone, and Rust is told to stop after it started
    expect(unlisteners.length).toBeGreaterThan(0)
    for (const unlisten of unlisteners) expect(unlisten).toHaveBeenCalled()
    const order = globalThis.mockTauri.invoke.mock.calls.map(c => c[0])
    expect(order.lastIndexOf('stop_watching_project')).toBeGreaterThan(
      order.indexOf('start_watching_project_with_content_dir')
    )
    expect(useProjectStore.getState()._unlistenFileChanged).toBeNull()
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
