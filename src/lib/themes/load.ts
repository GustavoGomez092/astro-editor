import { commands } from '@/lib/bindings'
import schema from './theme.schema.json'
import { BUILTIN_THEMES } from './builtin'
import { validateTheme } from './validate'
import type { ThemeFile } from './types'

const SCHEMA_FILE = 'theme.schema.json'
const BUILTIN_IDS = new Set(BUILTIN_THEMES.map(theme => theme.id))

/**
 * Reads every .json file in the themes folder. A file that can't be used is
 * returned with what's wrong, so Settings can show it. Also keeps a copy of the
 * schema in the folder, so editors can check and complete a theme as it's typed.
 */
export async function loadThemeFiles(): Promise<ThemeFile[]> {
  const dirResult = await commands.getAppDataDir()
  const listResult = await commands.listThemeFiles()
  if (dirResult.status === 'error') throw new Error(dirResult.error)
  if (listResult.status === 'error') throw new Error(listResult.error)
  const dir = `${dirResult.data}/themes`

  void commands.writeAppDataFile(
    `${dir}/${SCHEMA_FILE}`,
    JSON.stringify(schema, null, 2) + '\n'
  )

  const files: ThemeFile[] = []
  const seen = new Set<string>()
  for (const file of listResult.data) {
    if (file === SCHEMA_FILE) continue
    const read = await commands.readAppDataFile(`${dir}/${file}`)
    if (read.status === 'error') {
      files.push({ file, ok: false, errors: ['The file could not be read.'] })
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(read.data)
    } catch (err) {
      files.push({
        file,
        ok: false,
        errors: [`Not valid JSON: ${(err as Error).message}`],
      })
      continue
    }
    const result = validateTheme(parsed)
    if (!result.ok) {
      files.push({ file, ok: false, errors: result.errors })
    } else if (seen.has(result.theme.id) || BUILTIN_IDS.has(result.theme.id)) {
      files.push({
        file,
        ok: false,
        errors: [
          `Another theme already uses the id "${result.theme.id}". Change "id" so each theme has its own.`,
        ],
      })
    } else {
      seen.add(result.theme.id)
      files.push({
        file,
        ok: true,
        theme: result.theme,
        warnings: result.warnings,
      })
    }
  }
  return files
}
