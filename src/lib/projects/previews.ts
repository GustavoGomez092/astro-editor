import { commands } from '@/lib/bindings'

/** A picture of a site for its Home card (the previews engine's contract) */
export interface ProjectPreview {
  kind: 'screenshot' | 'share-image'
  /** A data: URL, JPEG, at most 800 px wide */
  src: string
  /** When the screenshot was taken; null for a share image */
  takenAt: string | null
}

type PreviewResult =
  | { status: 'ok'; data: ProjectPreview | null }
  | { status: 'error'; error: string }

interface PreviewCommands {
  projectPreview: (path: string) => Promise<PreviewResult>
  captureProjectPreview: (path: string) => Promise<PreviewResult>
}

// Narrowed here so Home works in a build where the engine's commands aren't
// registered: a site then just shows its initial
const api = commands as unknown as Partial<PreviewCommands>

async function run(
  call: ((path: string) => Promise<PreviewResult>) | undefined,
  path: string
): Promise<ProjectPreview | null> {
  if (!call) return null
  const result = await call(path)
  if (result.status === 'error') throw new Error(result.error)
  return result.data
}

/** The stored screenshot, else the site's share image, else null. Fast */
export const getProjectPreview = (path: string) => run(api.projectPreview, path)

/** Takes a new screenshot of the running site and returns it */
export const refreshProjectPreview = (path: string) =>
  run(api.captureProjectPreview, path)

/** Emitted whenever a stored preview changes */
export const PREVIEW_UPDATED_EVENT = 'project-preview-updated'
