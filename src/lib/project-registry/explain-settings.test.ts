import { describe, it, expect } from 'vitest'
import { explainCollectionSettings } from './explain-settings'
import { DEFAULT_GLOBAL_SETTINGS, DEFAULT_PROJECT_SETTINGS } from './defaults'
import type { CollectionSpecificSettings, ProjectSettings } from './types'
import { FieldType, type SchemaField } from '../schema'

const field = (name: string, type: FieldType): SchemaField => ({
  name,
  label: name,
  type,
  required: false,
})

const BLOG_FIELDS = [
  field('title', FieldType.String),
  field('description', FieldType.String),
  field('draft', FieldType.Boolean),
  field('pubDate', FieldType.Date),
]

const PROJECT = '/sites/blog'

function explain({
  settings,
  project = DEFAULT_PROJECT_SETTINGS,
  fields = BLOG_FIELDS,
  path = `${PROJECT}/src/content/blog`,
  loaderBase = null,
}: {
  settings?: CollectionSpecificSettings
  project?: ProjectSettings
  fields?: SchemaField[] | null
  path?: string
  loaderBase?: string | null
} = {}) {
  return explainCollectionSettings({
    collection: { name: 'blog', path, loader_base: loaderBase },
    projectPath: PROJECT,
    projectSettings: {
      ...project,
      collections: settings ? [{ name: 'blog', settings }] : [],
    },
    globalSettings: DEFAULT_GLOBAL_SETTINGS,
    fields,
  })
}

describe('explainCollectionSettings: content folder', () => {
  it('says the folder comes from the glob loader', () => {
    expect(
      explain({
        path: `${PROJECT}/writing/posts`,
        loaderBase: 'writing/posts',
      }).contentFolder
    ).toEqual({
      state: 'inferred',
      value: 'writing/posts',
      reason: 'from the glob loader',
    })
  })

  it('says the folder is the content folder plus the collection name', () => {
    expect(explain().contentFolder).toEqual({
      state: 'inferred',
      value: 'src/content/blog',
      reason: "the content folder and the collection's name",
    })
  })

  it('shows a folder set for the collection as set', () => {
    expect(
      explain({ settings: { pathOverrides: { contentDirectory: 'posts/' } } })
        .contentFolder
    ).toMatchObject({ state: 'set', value: 'posts' })
  })
})

describe('explainCollectionSettings: assets folder', () => {
  it("uses Astro's usual folder unless the project has another", () => {
    expect(explain().assetsFolder).toMatchObject({
      state: 'inferred',
      value: 'src/assets',
      reason: "Astro's usual folder",
    })
    expect(
      explain({
        project: {
          ...DEFAULT_PROJECT_SETTINGS,
          pathOverrides: { assetsDirectory: 'public/images/' },
        },
      }).assetsFolder
    ).toMatchObject({
      state: 'inferred',
      value: 'public/images',
      reason: "the project's setting",
    })
  })
})

describe('explainCollectionSettings: fields', () => {
  it('says a field was found in the schema', () => {
    expect(explain().draft).toEqual({
      state: 'inferred',
      value: 'draft',
      reason: 'found in the schema',
    })
    expect(explain().title.reason).toBe('found in the schema')
  })

  it('warns when the schema has no draft field', () => {
    const { draft } = explain({
      fields: BLOG_FIELDS.filter(f => f.name !== 'draft'),
    })
    expect(draft.state).toBe('inferred')
    expect(draft.value).toBeNull()
    expect(draft.reason).toBe('no `draft` field in the schema')
    expect(draft.warning).toBe('Nothing will be marked as a draft.')
  })

  it("warns when the field isn't the right kind", () => {
    const { draft } = explain({
      fields: [field('draft', FieldType.String)],
    })
    expect(draft.value).toBeNull()
    expect(draft.reason).toBe("`draft` in the schema isn't a yes/no field")
    expect(draft.warning).toBeDefined()
  })

  it('uses the usual name for a collection without a schema', () => {
    expect(explain({ fields: null }).title).toEqual({
      state: 'inferred',
      value: 'title',
      reason: 'the usual name, as this collection has no schema',
    })
  })

  it('shows a field set for the collection as set, and warns if the schema lacks it', () => {
    expect(
      explain({ settings: { frontmatterMappings: { title: 'name' } } }).title
    ).toEqual({
      state: 'set',
      value: 'name',
      reason: 'set for this collection',
      warning: "This collection's schema has no `name` field.",
    })
  })

  it('finds the first usual date field in the schema', () => {
    expect(
      explain({ fields: [field('date', FieldType.Date)] }).publishedDate
    ).toEqual({
      state: 'inferred',
      value: 'date',
      reason: 'found in the schema',
    })
    expect(explain({ fields: [] }).publishedDate).toMatchObject({
      value: null,
      reason: 'no pubDate, date or publishedDate field in the schema',
    })
  })
})

describe('explainCollectionSettings: sort and file type', () => {
  it('describes the Default sort from the date field', () => {
    expect(explain().sort).toEqual({
      state: 'inferred',
      value: 'Newest first',
      reason: 'by `pubDate`, with files that have no date at the top',
    })
    expect(explain({ fields: [] }).sort).toMatchObject({
      value: 'By title',
      reason: 'no date field was found',
    })
  })

  it('describes a sort chosen in the file list', () => {
    expect(
      explain({ settings: { sort: { mode: 'title', direction: 'desc' } } }).sort
    ).toEqual({
      state: 'set',
      value: 'Title, Z to A',
      reason: 'set here or in the file list',
    })
    expect(
      explain({
        settings: { sort: { mode: 'date-pubDate', direction: 'asc' } },
      }).sort.value
    ).toBe('pubDate, oldest first')
  })

  it('says where the file type comes from', () => {
    expect(explain().fileType).toEqual({
      state: 'inferred',
      value: 'Markdown (.md)',
      reason: 'the app setting',
    })
    expect(
      explain({
        project: { ...DEFAULT_PROJECT_SETTINGS, defaultFileType: 'mdx' },
      }).fileType
    ).toMatchObject({ value: 'MDX (.mdx)', reason: "the project's setting" })
    expect(explain({ settings: { defaultFileType: 'mdx' } }).fileType).toEqual({
      state: 'set',
      value: 'MDX (.mdx)',
      reason: 'set for this collection',
    })
  })
})
