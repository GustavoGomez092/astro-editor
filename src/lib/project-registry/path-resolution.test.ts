import { describe, it, expect } from 'vitest'
import {
  checkCollectionFolder,
  getCollectionFolderOverrides,
} from './path-resolution'
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

describe('checkCollectionFolder', () => {
  it('accepts a folder inside the project', () => {
    expect(checkCollectionFolder('writing/posts', 'src/content/')).toBeNull()
    expect(
      checkCollectionFolder('./src/content/blog/', 'src/content/')
    ).toBeNull()
  })

  it('refuses the project folder itself', () => {
    for (const folder of ['.', './', '', ' ']) {
      expect(checkCollectionFolder(folder, 'src/content/')).toMatch(
        /the project folder itself/
      )
    }
  })

  it('refuses a folder outside the project', () => {
    for (const folder of [
      '..',
      '../other-site',
      'src/../../other',
      '/Users/kevin/posts',
      '\\server\\share',
      'C:\\posts',
    ]) {
      expect(checkCollectionFolder(folder, 'src/content/')).toMatch(
        /isn't inside the project folder/
      )
    }
  })

  it('refuses the content folder itself', () => {
    for (const folder of ['src/content', './src/content/']) {
      expect(checkCollectionFolder(folder, 'src/content/')).toMatch(
        /the content folder itself/
      )
    }
  })
})

describe("getCollectionFolderOverrides with folders that can't be used", () => {
  it('leaves them out, so the collection is found automatically', () => {
    expect(
      getCollectionFolderOverrides(
        project([
          {
            name: 'blog',
            settings: { pathOverrides: { contentDirectory: 'src/content' } },
          },
          {
            name: 'notes',
            settings: { pathOverrides: { contentDirectory: '../x' } },
          },
          {
            name: 'ideas',
            settings: { pathOverrides: { contentDirectory: 'ideas' } },
          },
        ])
      )
    ).toEqual({ ideas: 'ideas' })
  })
})
