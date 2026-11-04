import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import type { ChangedFile } from '@/lib/bindings'
import type { Collection, FileEntry } from '@/types'
import { queryKeys } from '@/lib/query-keys'
import { useEditorStore } from '@/store/editorStore'
import { entriesNeedingAttention, publishCheckMessage } from './publish-check'

vi.mock('@/lib/project-registry', () => ({
  getCollectionSettings: () => ({ frontmatterMappings: { title: 'title' } }),
}))

const SITE = '/site'
const COLLECTION = {
  name: 'testimonials',
  path: '/site/src/content/testimonials',
  complete_schema: JSON.stringify({
    collectionName: 'testimonials',
    fields: [
      { name: 'title', label: 'Title', fieldType: 'string', required: true },
      { name: 'email', label: 'Email', fieldType: 'email', required: true },
      { name: 'quote', label: 'Quote', fieldType: 'string', required: true },
    ],
  }),
} as Collection

const entry = (
  name: string,
  frontmatter: NonNullable<FileEntry['frontmatter']>
): FileEntry => ({
  id: `testimonials/${name}`,
  path: `${COLLECTION.path}/${name}.md`,
  name,
  extension: 'md',
  collection: 'testimonials',
  last_modified: null,
  frontmatter,
})

const changed = (name: string, change: ChangedFile['change'] = 'modified') => ({
  path: `src/content/testimonials/${name}.md`,
  oldPath: null,
  change,
})

function cache(entries: FileEntry[]) {
  const client = new QueryClient()
  client.setQueryData(queryKeys.collections(SITE), [COLLECTION])
  client.setQueryData(
    queryKeys.collectionFiles(SITE, 'testimonials', COLLECTION.path),
    entries
  )
  return client
}

describe('entriesNeedingAttention', () => {
  beforeEach(() => {
    useEditorStore.setState({ currentFile: null, frontmatter: {} })
  })

  it('lists changed entries whose fields fail the schema, with a count', async () => {
    const client = cache([
      entry('jordan', { title: 'Jordan Ellis', email: 'nope' }),
      entry('fine', { title: 'Fine', email: 'a@b.co', quote: 'Hi' }),
    ])
    const found = await entriesNeedingAttention(client, SITE, [
      changed('jordan'),
      changed('fine'),
    ])
    expect(found).toEqual([
      expect.objectContaining({
        title: 'Jordan Ellis',
        fields: ['email', 'quote'],
      }),
    ])
  })

  it('checks an entry against the innermost collection holding it', async () => {
    // A collection whose folder holds the testimonials folder, listed first
    const outer = {
      name: 'pages',
      path: '/site/src/content',
      complete_schema: JSON.stringify({
        collectionName: 'pages',
        fields: [
          {
            name: 'title',
            label: 'Title',
            fieldType: 'string',
            required: true,
          },
        ],
      }),
    } as Collection
    const client = cache([entry('jordan', { title: 'Jordan', email: 'nope' })])
    client.setQueryData(queryKeys.collections(SITE), [outer, COLLECTION])
    client.setQueryData(
      queryKeys.collectionFiles(SITE, 'pages', outer.path),
      []
    )

    const found = await entriesNeedingAttention(client, SITE, [
      changed('jordan'),
    ])
    expect(found).toEqual([
      expect.objectContaining({ title: 'Jordan', fields: ['email', 'quote'] }),
    ])
  })

  it('checks the open file as it is in the editor', async () => {
    const jordan = entry('jordan', { title: 'Jordan Ellis' })
    const client = cache([jordan])
    useEditorStore.setState({
      currentFile: jordan,
      frontmatter: { title: 'Jordan Ellis', email: 'a@b.co', quote: 'Hi' },
    })
    expect(
      await entriesNeedingAttention(client, SITE, [changed('jordan')])
    ).toEqual([])
  })

  it('skips deleted files and files outside collections', async () => {
    const client = cache([entry('jordan', {})])
    expect(
      await entriesNeedingAttention(client, SITE, [
        changed('jordan', 'deleted'),
        { path: 'src/assets/a.jpg', oldPath: null, change: 'added' },
      ])
    ).toEqual([])
  })
})

describe('publishCheckMessage', () => {
  const problem = (title: string | null, count: number) => ({
    path: 'x',
    entry: null,
    title,
    fields: Array.from({ length: count }, (_, i) => `f${i}`),
  })

  it('names one entry and its count', () => {
    expect(publishCheckMessage([problem('Jordan Ellis', 2)])).toBe(
      '2 fields in “Jordan Ellis” need attention. Publish anyway?'
    )
    expect(publishCheckMessage([problem('Jordan Ellis', 1)])).toBe(
      '1 field in “Jordan Ellis” needs attention. Publish anyway?'
    )
    expect(publishCheckMessage([problem(null, 1)])).toBe(
      '1 field in an entry needs attention. Publish anyway?'
    )
  })

  it('counts entries when there are several', () => {
    expect(publishCheckMessage([problem('A', 1), problem('B', 3)])).toBe(
      '4 fields in 2 entries need attention. Publish anyway?'
    )
  })
})
