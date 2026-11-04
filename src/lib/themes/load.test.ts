import { describe, it, expect, vi, beforeEach } from 'vitest'

const files: Record<string, string> = {}
let listing: { name: string; problem: string | null }[] = []
const write = vi.fn(() => Promise.resolve({ status: 'ok', data: null }))

vi.mock('@/lib/bindings', () => ({
  commands: {
    getAppDataDir: () => Promise.resolve({ status: 'ok', data: '/data' }),
    listThemeFiles: () => Promise.resolve({ status: 'ok', data: listing }),
    readAppDataFile: (path: string) =>
      path in files
        ? Promise.resolve({ status: 'ok', data: files[path] })
        : Promise.resolve({ status: 'error', error: 'missing' }),
    writeAppDataFile: (...args: unknown[]) => write(...(args as [])),
  },
}))

import { loadThemeFiles } from './load'
import schema from './theme.schema.json'

const theme = (id: string) =>
  JSON.stringify({
    id,
    name: id,
    appearance: 'both',
    tokens: { background: '#112233' },
  })

beforeEach(() => {
  for (const key of Object.keys(files)) delete files[key]
  listing = []
  write.mockClear()
})

describe('loadThemeFiles', () => {
  it('lists problems the folder scan found without reading the file, and still loads the others', async () => {
    listing = [
      { name: 'big.json', problem: 'The file is too large to be a theme.' },
      {
        name: 'link.json',
        problem: 'The file links to a file outside the themes folder.',
      },
      { name: 'ok.json', problem: null },
    ]
    files['/data/themes/ok.json'] = theme('ok')
    const result = await loadThemeFiles()
    expect(result[0]).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('too large')],
    })
    expect(result[1]).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('outside the themes folder')],
    })
    expect(result[2]).toMatchObject({ ok: true })
  })

  it('names the file that won when two share an id', async () => {
    listing = [
      { name: 'a.json', problem: null },
      { name: 'b.json', problem: null },
      { name: 'c.json', problem: null },
    ]
    files['/data/themes/a.json'] = theme('same')
    files['/data/themes/b.json'] = theme('same')
    files['/data/themes/c.json'] = theme('nord')
    const result = await loadThemeFiles()
    expect(result[0]).toMatchObject({ ok: true })
    expect(result[1]).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('already used by a.json')],
    })
    expect(result[2]).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('built-in theme')],
    })
  })

  it('reports invalid JSON and skips the schema copy', async () => {
    listing = [
      { name: 'bad.json', problem: null },
      { name: 'theme.schema.json', problem: null },
    ]
    files['/data/themes/bad.json'] = '{ nope'
    const result = await loadThemeFiles()
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ ok: false })
  })

  it('writes the schema copy only when it is missing or different', async () => {
    await loadThemeFiles()
    await Promise.resolve()
    expect(write).toHaveBeenCalledTimes(1)

    write.mockClear()
    files['/data/themes/theme.schema.json'] =
      JSON.stringify(schema, null, 2) + '\n'
    await loadThemeFiles()
    await Promise.resolve()
    expect(write).not.toHaveBeenCalled()

    files['/data/themes/theme.schema.json'] = '{}'
    await loadThemeFiles()
    await new Promise(r => setTimeout(r, 0))
    expect(write).toHaveBeenCalledTimes(1)
  })
})
