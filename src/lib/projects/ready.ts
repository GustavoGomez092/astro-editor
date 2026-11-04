import { useProjectStore } from '../../store/projectStore'

/**
 * Waits until the project store reflects `targetPath` as the active project with
 * its settings loaded. Resolves `false` if that doesn't happen within `timeoutMs`.
 *
 * `setProject` is fire-and-forget, so deep-link handling must wait for the switch
 * to complete before resolving/opening a file in the new project.
 */
export function waitForProjectReady(
  targetPath: string,
  timeoutMs = 8000
): Promise<boolean> {
  const state = useProjectStore.getState()
  if (state.projectPath === targetPath && state.currentProjectSettings) {
    return Promise.resolve(true)
  }

  return new Promise<boolean>(resolve => {
    const handles: {
      unsubscribe?: () => void
      timer?: ReturnType<typeof setTimeout>
    } = {}

    handles.timer = setTimeout(() => {
      handles.unsubscribe?.()
      resolve(false)
    }, timeoutMs)

    handles.unsubscribe = useProjectStore.subscribe(current => {
      if (
        current.projectPath === targetPath &&
        current.currentProjectSettings
      ) {
        clearTimeout(handles.timer)
        handles.unsubscribe?.()
        resolve(true)
      }
    })
  })
}
