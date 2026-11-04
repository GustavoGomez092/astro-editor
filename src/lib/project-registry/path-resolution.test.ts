import { describe, it, expect } from 'vitest'
import { getCollectionFolderOverrides } from './path-resolution'
import type { ProjectSettings } from './types'

const project = (collections: ProjectSettings['collections']) =>
  ({
    pathOverrides: {},
    frontmatterMappings: {},
    collections,
  }) as ProjectSettings

describe('getCollectionFolderOverrides', () => {
  it('lists the content folder set for each collection', () => {
    expect(
      getCollectionFolderOverrides(
        project([
          {
            name: 'blog',
            settings: { pathOverrides: { contentDirectory: 'writing/' } },
          },
          {
            name: 'notes',
            settings: { pathOverrides: { assetsDirectory: 'x' } },
          },
          { name: 'ideas', settings: { defaultFileType: 'mdx' } },
        ])
      )
    ).toEqual({ blog: 'writing/' })
  })

  it('is null when no collection has one', () => {
    expect(getCollectionFolderOverrides(project([]))).toBeNull()
    expect(getCollectionFolderOverrides(null)).toBeNull()
  })
})
