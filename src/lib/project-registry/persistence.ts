/**
 * Project registry persistence layer
 *
 * Handles saving and loading project data using the application support directory
 */

import { commands } from '@/lib/bindings'
import { error, info } from '@tauri-apps/plugin-log'
import { toast } from '@/lib/toast'
import { ProjectRegistry, GlobalSettings, ProjectData } from './types'
import { DEFAULT_PROJECT_REGISTRY, DEFAULT_GLOBAL_SETTINGS } from './defaults'
import {
  needsGlobalSettingsMigration,
  needsProjectDataMigration,
  migrateGlobalSettingsWithLogging,
  migrateProjectDataWithLogging,
} from './migrations'

/**
 * Get the application support directory paths
 */
async function getAppSupportPaths() {
  const result = await commands.getAppDataDir()
  if (result.status === 'error') {
    throw new Error(result.error)
  }
  const appDataDir = result.data
  return {
    preferencesDir: `${appDataDir}/preferences`,
    projectsDir: `${appDataDir}/preferences/projects`,
    globalSettingsPath: `${appDataDir}/preferences/global-settings.json`,
    projectRegistryPath: `${appDataDir}/preferences/project-registry.json`,
  }
}

/**
 * Ensure preferences directory exists
 */
async function ensurePreferencesDir() {
  const { preferencesDir, projectsDir } = await getAppSupportPaths()

  try {
    // Use the safer app data file operations that create directories as needed
    const prefResult = await commands.writeAppDataFile(
      `${preferencesDir}/.init`,
      'directory initialized'
    )
    if (prefResult.status === 'error') {
      throw new Error(prefResult.error)
    }

    const projResult = await commands.writeAppDataFile(
      `${projectsDir}/.init`,
      'directory initialized'
    )
    if (projResult.status === 'error') {
      throw new Error(projResult.error)
    }
  } catch (err) {
    await error(`Failed to ensure preferences directories: ${String(err)}`)
    throw err
  }
}

/** A preferences file read from disk */
type JsonFile =
  | { kind: 'missing' }
  | { kind: 'ok'; data: Record<string, unknown> }
  /** `kept`: a copy was made, so the defaults may be written over it */
  | { kind: 'broken'; kept: boolean }

/**
 * Broken preferences files that couldn't be copied. Nothing is written over
 * them: the defaults are used in memory only, and the writer is told again
 * each time the app starts
 */
const unsafeToOverwrite = new Set<string>()

/**
 * Read a preferences file. One that isn't there is missing (it's new). One
 * that's there but can't be read, or isn't a JSON object, is broken: it's
 * copied to `<name>.broken-<timestamp>.json` beside it, logged, and the
 * writer is told. The caller writes defaults over it only if it was kept
 */
async function readJsonFile(path: string): Promise<JsonFile> {
  const result = await commands
    .readAppDataFileIfPresent(path)
    .catch((reason: unknown) => ({
      status: 'error' as const,
      error: String(reason),
    }))
  const text = result.status === 'ok' ? result.data : undefined
  if (text === null) return { kind: 'missing' }

  const data = text === undefined ? null : parseObject(text)
  if (data) return { kind: 'ok', data }
  const problem =
    result.status === 'error' ? result.error : "it isn't valid JSON"
  return { kind: 'broken', kept: await keepBrokenFile(path, problem) }
}

function parseObject(content: string): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(content)
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** "…/preferences/projects/site.json" → "projects/site.json" */
function inPreferencesFolder(path: string): string {
  const parts = path.split(/[\\/]/)
  const at = parts.lastIndexOf('preferences')
  return at >= 0 ? parts.slice(at + 1).join('/') : (parts.at(-1) ?? path)
}

/** Copy a broken file beside itself, and say so. Whether the copy was made */
async function keepBrokenFile(path: string, problem: string): Promise<boolean> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const copyPath = path.replace(/\.json$/, '') + `.broken-${stamp}.json`
  const copied = await commands
    .copyAppDataFile(path, copyPath)
    .then(result => result.status === 'ok')
    .catch(() => false)
  if (copied) {
    unsafeToOverwrite.delete(path)
  } else {
    unsafeToOverwrite.add(path)
  }

  await error(
    `Astro Editor [PREFERENCES] ${path} couldn't be used (${problem}), so defaults are used. ${
      copied
        ? `It was kept as ${copyPath}`
        : "A copy couldn't be made, so it's left as it is and nothing is saved over it"
    }`
  )
  toast.warning("Some settings couldn't be read", {
    id: `broken-preferences-${path}`,
    description: copied
      ? `A settings file was damaged, so the defaults are being used. The old file was kept as ${inPreferencesFolder(copyPath)} in the preferences folder.`
      : `A settings file (${inPreferencesFolder(path)}) couldn't be read, so the defaults are being used for now. It's been left as it is, and changes to these settings won't be saved until it's fixed or removed.`,
    duration: Infinity,
    action: {
      label: 'Show',
      onClick: () => void commands.openPreferencesFolder(),
    },
  })
  return copied
}

/** Write a preferences file, unless it's a broken one that couldn't be kept */
async function writePreferencesFile(
  path: string,
  content: string
): Promise<void> {
  if (unsafeToOverwrite.has(path)) {
    await info(
      `Astro Editor [PREFERENCES] Not saving ${path}: it couldn't be read or copied`
    )
    return
  }
  const result = await commands.writeAppDataFile(path, content)
  if (result.status === 'error') {
    throw new Error(result.error)
  }
}

/**
 * Load the project registry from disk
 */
export async function loadProjectRegistry(): Promise<ProjectRegistry> {
  const defaults = (): ProjectRegistry => ({
    ...DEFAULT_PROJECT_REGISTRY,
    projects: {},
  })
  try {
    const { projectRegistryPath } = await getAppSupportPaths()
    const file = await readJsonFile(projectRegistryPath)
    if (file.kind === 'missing') return defaults()
    if (file.kind === 'broken') {
      // Written now when a copy was kept, so it isn't reported again
      const registry = defaults()
      if (file.kept) await saveProjectRegistry(registry).catch(() => undefined)
      return registry
    }

    const registry = file.data as Partial<ProjectRegistry>
    return {
      ...defaults(),
      ...registry,
      version: registry.version || 1,
    }
  } catch {
    return defaults()
  }
}

/**
 * Save the project registry to disk
 */
export async function saveProjectRegistry(
  registry: ProjectRegistry
): Promise<void> {
  try {
    await ensurePreferencesDir()
    const { projectRegistryPath } = await getAppSupportPaths()

    await writePreferencesFile(
      projectRegistryPath,
      JSON.stringify(registry, null, 2)
    )
  } catch (err) {
    await error(`Failed to save project registry: ${String(err)}`)
    throw err
  }
}

/**
 * Load global settings from disk
 */
export async function loadGlobalSettings(): Promise<GlobalSettings> {
  try {
    const { globalSettingsPath } = await getAppSupportPaths()
    const file = await readJsonFile(globalSettingsPath)
    if (file.kind === 'missing') return defaultGlobalSettings()
    if (file.kind === 'broken') {
      // Written now when a copy was kept, so it isn't reported again
      const settings = defaultGlobalSettings()
      if (file.kept) await saveGlobalSettings(settings).catch(() => undefined)
      return settings
    }
    const rawSettings = file.data

    // Check if migration is needed
    if (needsGlobalSettingsMigration(rawSettings)) {
      await info(
        'Astro Editor [PREFERENCES] Global settings v1 detected, migrating to v2'
      )

      // Migrate the settings
      const migratedSettings =
        await migrateGlobalSettingsWithLogging(rawSettings)

      // Save the migrated settings to disk
      await saveGlobalSettings(migratedSettings)

      await info(
        'Astro Editor [PREFERENCES] Global settings migration completed and saved'
      )

      return migratedSettings
    }

    // Validate and deep merge to preserve nested objects
    const settings = rawSettings as Partial<GlobalSettings>
    return {
      ...DEFAULT_GLOBAL_SETTINGS,
      ...settings,
      general: {
        ...DEFAULT_GLOBAL_SETTINGS.general,
        ...(settings.general || {}),
        highlights: {
          ...DEFAULT_GLOBAL_SETTINGS.general.highlights,
          ...(settings.general?.highlights || {}),
        },
      },
      appearance: {
        ...DEFAULT_GLOBAL_SETTINGS.appearance,
        ...(settings.appearance || {}),
        headingColor: {
          ...DEFAULT_GLOBAL_SETTINGS.appearance.headingColor,
          ...(settings.appearance?.headingColor || {}),
        },
      },
      version: settings.version || DEFAULT_GLOBAL_SETTINGS.version,
    }
  } catch {
    return defaultGlobalSettings()
  }
}

/** A deep copy, so nothing changes the defaults themselves */
function defaultGlobalSettings(): GlobalSettings {
  return JSON.parse(JSON.stringify(DEFAULT_GLOBAL_SETTINGS)) as GlobalSettings
}

/**
 * Save global settings to disk
 */
export async function saveGlobalSettings(
  settings: GlobalSettings
): Promise<void> {
  try {
    await ensurePreferencesDir()
    const { globalSettingsPath } = await getAppSupportPaths()

    await writePreferencesFile(
      globalSettingsPath,
      JSON.stringify(settings, null, 2)
    )
  } catch (err) {
    await error(`Failed to save global settings: ${String(err)}`)
    throw err
  }
}

/**
 * Load project-specific data from disk
 */
export async function loadProjectData(
  projectId: string
): Promise<ProjectData | null> {
  try {
    const { projectsDir } = await getAppSupportPaths()
    const projectFilePath = `${projectsDir}/${projectId}.json`

    // The caller replaces a broken file with defaults; one that couldn't be
    // copied isn't written over (writePreferencesFile)
    const file = await readJsonFile(projectFilePath)
    if (file.kind !== 'ok') return null
    const rawData = file.data

    // Check if migration is needed
    if (needsProjectDataMigration(rawData)) {
      await info(
        `Astro Editor [PREFERENCES] Project data v1 detected for ${projectId}, migrating to v2`
      )

      // Migrate the project data
      const migratedData = await migrateProjectDataWithLogging(
        projectId,
        rawData
      )

      // Save the migrated data to disk
      await saveProjectData(projectId, migratedData)

      await info(
        `Astro Editor [PREFERENCES] Project data migration completed and saved for ${projectId}`
      )

      return migratedData
    }

    return rawData as Partial<ProjectData> as ProjectData
  } catch {
    return null
  }
}

/**
 * Save project-specific data to disk
 */
export async function saveProjectData(
  projectId: string,
  data: ProjectData
): Promise<void> {
  try {
    await ensurePreferencesDir()
    const { projectsDir } = await getAppSupportPaths()
    const projectFilePath = `${projectsDir}/${projectId}.json`

    await writePreferencesFile(projectFilePath, JSON.stringify(data, null, 2))
  } catch (err) {
    await error(`Failed to save project data: ${String(err)}`)
    throw err
  }
}
