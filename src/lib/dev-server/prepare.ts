import { warn as logWarn } from '@tauri-apps/plugin-log'
import { commands, type Collection } from '@/lib/bindings'
import { queryClient } from '@/lib/query-client'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

/**
 * Whether an Astro site still needs `astro sync` before its forms can show
 * every field: it has `astro` in package.json and collections, but none of
 * their JSON schemas in `.astro/collections` (a fresh clone has no `.astro`).
 */
/** Whether the project's package.json lists `astro`. */
export async function isAstroSite(projectPath: string): Promise<boolean> {
  const dependencies = await commands.projectDependencies(projectPath)
  return dependencies.status === 'ok' && dependencies.data.includes('astro')
}

export async function siteNeedsPreparing(
  projectPath: string,
  collections: Pick<Collection, 'name'>[]
): Promise<boolean> {
  if (collections.length === 0) return false
  if (!(await isAstroSite(projectPath))) return false
  const root = projectPath.replace(/\/+$/, '')
  for (const collection of collections) {
    const schema = await commands.readFileContent(
      `${root}/.astro/collections/${collection.name}.schema.json`,
      projectPath
    )
    if (schema.status === 'ok') return false
  }
  return true
}

/**
 * Installs the site's dependencies if needed and runs `astro sync`, so the
 * collection schemas exist, then reloads the collections. Resolves false
 * (and logs why) if it failed; Preview's output shows the details.
 */
export async function prepareSite(projectPath: string): Promise<boolean> {
  const result = await commands.devServerPrepare(projectPath)
  const failure =
    result.status === 'error'
      ? result.error
      : result.data.status === 'error'
        ? (result.data.error ?? 'unknown error')
        : null
  void queryClient.invalidateQueries({
    queryKey: queryKeys.devServer(projectPath),
  })
  if (failure !== null) {
    void logWarn(
      `Astro Editor [DEV_SERVER] Preparing ${projectPath} failed: ${failure}`
    )
    return false
  }
  await queryClient.invalidateQueries({
    queryKey: queryKeys.collections(projectPath),
  })
  return true
}

const PREPARE_TOAST = 'prepare-site'

/** Projects checked (or prepared) since launch, so each is asked once. */
const checked = new Set<string>()

/** Marks a project as prepared already, e.g. by Open from GitHub. */
export function markSitePrepared(projectPath: string): void {
  checked.add(projectPath)
}

/**
 * On opening a project: prepares it once if it needs it (see
 * `siteNeedsPreparing`), saying so while it runs.
 */
export async function prepareSiteIfNeeded(
  projectPath: string,
  collections: Pick<Collection, 'name'>[]
): Promise<void> {
  // No collections yet may only mean they haven't been read: decide later
  if (checked.has(projectPath) || collections.length === 0) return
  checked.add(projectPath)
  if (!(await siteNeedsPreparing(projectPath, collections))) return

  toast.info('Preparing your site…', {
    id: PREPARE_TOAST,
    description: 'Reading its collections, so every field shows.',
    duration: Infinity,
    // A hung install mustn't leave this up for good
    action: {
      label: 'Stop',
      onClick: () => void commands.devServerStop(projectPath),
    },
  })
  if (await prepareSite(projectPath)) {
    toast.success('Your site is ready.', { id: PREPARE_TOAST, duration: 4000 })
  } else {
    toast.warning("Couldn't prepare the site, so some fields may be missing.", {
      id: PREPARE_TOAST,
      description: "Preview's output shows what went wrong.",
    })
  }
}
