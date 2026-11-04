import { describe, it, expect } from 'vitest'
import { filterProjects, folderName, shortenHome } from './recent'
import type { ProjectMetadata } from '../project-registry/types'

const project = (
  name: string,
  path: string,
  lastOpened: string
): ProjectMetadata => ({
  id: name,
  name,
  path,
  lastOpened,
  created: lastOpened,
})

const projects = [
  project('blog', '/Users/kevin/Sites/blog', '2026-10-01T10:00:00Z'),
  project('kevin-robinson', '/Users/kevin/Work/site', '2026-11-03T10:00:00Z'),
  project('docs', '/Users/kevin/Sites/starlight', '2026-10-20T10:00:00Z'),
]

describe('filterProjects', () => {
  it('lists every project, most recently opened first', () => {
    expect(filterProjects(projects, '').map(p => p.name)).toEqual([
      'kevin-robinson',
      'docs',
      'blog',
    ])
  })

  it('matches names and folders, ignoring case', () => {
    expect(filterProjects(projects, 'BLOG').map(p => p.name)).toEqual(['blog'])
    expect(filterProjects(projects, 'starlight').map(p => p.name)).toEqual([
      'docs',
    ])
  })

  it('needs every word to match', () => {
    expect(filterProjects(projects, 'sites doc').map(p => p.name)).toEqual([
      'docs',
    ])
    expect(filterProjects(projects, 'sites work')).toEqual([])
  })
})

describe('shortenHome', () => {
  it('writes the home folder as ~', () => {
    expect(shortenHome('/Users/kevin/Sites/blog')).toBe('~/Sites/blog')
    expect(shortenHome('/srv/site')).toBe('/srv/site')
  })
})

describe('folderName', () => {
  it('is the last part of the path', () => {
    expect(folderName('/Users/kevin/Sites/blog')).toBe('blog')
    expect(folderName('/Users/kevin/Sites/blog/')).toBe('blog')
  })
})
