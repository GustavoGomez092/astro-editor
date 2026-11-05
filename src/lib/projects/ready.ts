import { getOpenGeneration, useProjectStore } from '../../store/projectStore'

/**
 * Waits until the project store reflects `targetPath` as the active project with
 * its settings loaded. Resolves `false` if that doesn't happen within `timeoutMs`, or the open is cancelled.
 *
 * `setProject` is fire-and-forget, so deep-link handling must wait for the switch
 * to complete before resolving/opening a file in the new project.
 */
export function waitForProjectReady(
  targetPath: string,
  timeoutMs = 8000
): Promise<boolean> {
  // An open or close that starts later cancels the wait: the site isn't coming
  const generation = getOpenGeneration()
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
      if (getOpenGeneration() !== generation) {
        clearTimeout(handles.timer)
        handles.unsubscribe?.()
        resolve(false)
        return
      }
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
