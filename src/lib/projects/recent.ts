import type { ProjectMetadata } from '../project-registry/types'

/**
 * The projects whose name or folder has every word of `query`, ignoring case,
 * most recently opened first
 */
export function filterProjects<T extends ProjectMetadata>(
  projects: T[],
  query: string
): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return projects
    .filter(project => {
      const text = `${project.name} ${project.path}`.toLowerCase()
      return words.every(word => text.includes(word))
    })
    .sort((a, b) => b.lastOpened.localeCompare(a.lastOpened))
}

/** "/Users/kevin/Sites" → "~/Sites" */
export function shortenHome(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~')
}

/** The project's folder name, which the title bar shows too */
export function folderName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path
}
