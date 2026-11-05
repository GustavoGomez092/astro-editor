import { commands, type ProjectPreview } from '@/lib/bindings'
import { unwrap } from '@/lib/git/unwrap'

/** The stored screenshot, else the site's share image, else null. Fast */
export const getProjectPreview = (
  path: string
): Promise<ProjectPreview | null> => unwrap(commands.projectPreview(path))

/** Takes a new screenshot of the running site and returns it (or null) */
export const refreshProjectPreview = (
  path: string
): Promise<ProjectPreview | null> =>
  unwrap(commands.captureProjectPreview(path))

/** Emitted whenever a stored preview changes */
export const PREVIEW_UPDATED_EVENT = 'project-preview-updated'
