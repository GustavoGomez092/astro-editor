import { error as logError } from '@tauri-apps/plugin-log'
import { commands } from '@/lib/bindings'

/**
 * Stops a project's dev server without waiting for it (stopping can take a
 * few seconds while the server shuts down). Does nothing if none is running.
 */
export function stopDevServer(projectPath: string): void {
  void commands.devServerStop(projectPath).then(result => {
    if (result.status === 'error') {
      void logError(
        `Astro Editor [DEV_SERVER] Couldn't stop the dev server for ${projectPath}: ${result.error}`
      )
    }
  })
}
