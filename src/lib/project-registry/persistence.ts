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
  | { kind: 'broken' }

/**
 * Read a preferences file. One that can't be read is missing (it's new). One
 * that reads but isn't a JSON object is broken: it's copied to
 * `<name>.broken-<timestamp>.json` beside it, logged, and the writer is told,
 * before the caller replaces it with defaults
 */
async function readJsonFile(path: string): Promise<JsonFile> {
  let content: string
  try {
    const result = await commands.readAppDataFile(path)
    if (result.status === 'error') return { kind: 'missing' }
    content = result.data
  } catch {
    return { kind: 'missing' }
  }

  const data = parseObject(content)
  if (data) return { kind: 'ok', data }
  await keepBrokenFile(path, content)
  return { kind: 'broken' }
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

async function keepBrokenFile(path: string, content: string): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const copyPath = path.replace(/\.json$/, '') + `.broken-${stamp}.json`
  const copyName = copyPath.split('/').pop() ?? copyPath
  const copied = await commands
    .writeAppDataFile(copyPath, content)
    .then(result => result.status === 'ok')
    .catch(() => false)
  await error(
    `Astro Editor [PREFERENCES] ${path} isn't valid JSON, so defaults are used. ${
      copied ? `It was kept as ${copyPath}` : 'Keeping a copy failed'
    }`
  )
  toast.warning("Some settings couldn't be read", {
    id: `broken-preferences-${path}`,
    description: copied
      ? `A settings file was damaged, so the defaults are being used. The old file was kept as ${copyName} in the preferences folder.`
      : 'A settings file was damaged, so the defaults are being used.',
    duration: Infinity,
    action: {
      label: 'Show',
      onClick: () => void commands.openPreferencesFolder(),
    },
  })
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
      // Written now, so the broken file isn't reported again
      const registry = defaults()
      await saveProjectRegistry(registry).catch(() => undefined)
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

    const result = await commands.writeAppDataFile(
      projectRegistryPath,
      JSON.stringify(registry, null, 2)
    )
    if (result.status === 'error') {
      throw new Error(result.error)
    }
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
      // Written now, so the broken file isn't reported again
      const settings = defaultGlobalSettings()
      await saveGlobalSettings(settings).catch(() => undefined)
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

    const result = await commands.writeAppDataFile(
      globalSettingsPath,
      JSON.stringify(settings, null, 2)
    )
    if (result.status === 'error') {
      throw new Error(result.error)
    }
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

    // A broken file is kept, then replaced with defaults by the caller
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

    const result = await commands.writeAppDataFile(
      projectFilePath,
      JSON.stringify(data, null, 2)
    )
    if (result.status === 'error') {
      throw new Error(result.error)
    }
  } catch (err) {
    await error(`Failed to save project data: ${String(err)}`)
    throw err
  }
}
