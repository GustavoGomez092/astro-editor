import { commands } from '@/lib/bindings'
import schema from './theme.schema.json'
import { BUILTIN_THEMES } from './builtin'
import { validateTheme } from './validate'
import type { ThemeFile } from './types'

const SCHEMA_FILE = 'theme.schema.json'
const SCHEMA_TEXT = JSON.stringify(schema, null, 2) + '\n'
const BUILTIN_IDS = new Set(BUILTIN_THEMES.map(theme => theme.id))

/**
 * Keeps a copy of the schema in the themes folder, so editors can check and
 * complete a theme as it's typed. Only written when it's missing or out of date.
 */
async function ensureSchemaCopy(path: string) {
  const existing = await commands.readAppDataFile(path)
  if (existing.status === 'ok' && existing.data === SCHEMA_TEXT) return
  await commands.writeAppDataFile(path, SCHEMA_TEXT)
}

/**
 * Reads every .json file in the themes folder. A file that can't be used is
 * returned with what's wrong, so Settings can show it; one bad file never
 * stops the others loading.
 */
export async function loadThemeFiles(): Promise<ThemeFile[]> {
  const dirResult = await commands.getAppDataDir()
  const listResult = await commands.listThemeFiles()
  if (dirResult.status === 'error') throw new Error(dirResult.error)
  if (listResult.status === 'error') throw new Error(listResult.error)
  const dir = `${dirResult.data}/themes`

  void ensureSchemaCopy(`${dir}/${SCHEMA_FILE}`).catch(() => {})

  const files: ThemeFile[] = []
  const claimedBy = new Map<string, string>() // theme id -> the file that has it
  for (const { name: file, problem } of listResult.data) {
    if (file === SCHEMA_FILE) continue
    if (problem) {
      files.push({ file, ok: false, errors: [problem] })
      continue
    }
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
      continue
    }
    const { id } = result.theme
    const winner = claimedBy.get(id)
    if (BUILTIN_IDS.has(id) || winner) {
      files.push({
        file,
        ok: false,
        errors: [
          `The id "${id}" is already used by ${winner ?? 'a built-in theme'}. Change "id" so each theme has its own.`,
        ],
      })
      continue
    }
    claimedBy.set(id, file)
    files.push({
      file,
      ok: true,
      theme: result.theme,
      warnings: result.warnings,
    })
  }
  return files
}
