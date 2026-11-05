import type { ProjectMetadata } from '../project-registry/types'
import { filterProjects, folderName } from './recent'

/** Home shows its search box only with more sites than this */
export const SEARCH_THRESHOLD = 6

/** How many recent sites the title-bar switcher lists */
export const SWITCHER_SITES = 5

export const showSearch = (siteCount: number): boolean =>
  siteCount > SEARCH_THRESHOLD

/**
 * The first word of a person's name, or null when there isn't one. Emoji and
 * other symbols before the name ("🌴 Kevin Robinson") are skipped
 */
export function firstName(name: string | null | undefined): string | null {
  const text = name?.replace(/^[^\p{L}\p{N}]+/u, '').trim()
  return text?.split(/\s+/)[0] || null
}

/** "Good afternoon, Gustavo", or "Welcome back" when we don't know the name */
export function greetingFor(
  now: Date,
  name: string | null | undefined
): string {
  const first = firstName(name)
  if (!first) return 'Welcome back'
  const hour = now.getHours()
  const part =
    hour >= 5 && hour < 12
      ? 'morning'
      : hour >= 12 && hour < 18
        ? 'afternoon'
        : 'evening'
  return `Good ${part}, ${first}`
}

/** The letter a site without a picture shows */
export const siteInitial = (path: string): string =>
  folderName(path).charAt(0).toUpperCase()

/** The sites the switcher lists: newest first */
export const recentSites = <T extends ProjectMetadata>(projects: T[]): T[] =>
  filterProjects(projects, '').slice(0, SWITCHER_SITES)

/**
 * Where arrow keys move focus in the grid of cards. `columns` is how many
 * cards sit in a row. Null for a key that isn't a move
 */
export function nextCardIndex(
  index: number,
  count: number,
  columns: number,
  key: string
): number | null {
  const last = count - 1
  switch (key) {
    case 'ArrowRight':
      return Math.min(index + 1, last)
    case 'ArrowLeft':
      return Math.max(index - 1, 0)
    case 'ArrowDown':
      if (index + columns <= last) return index + columns
      // A shorter last row: go to its last card
      return Math.floor(last / columns) > Math.floor(index / columns)
        ? last
        : index
    case 'ArrowUp':
      return index - columns >= 0 ? index - columns : index
    case 'Home':
      return 0
    case 'End':
      return last
    default:
      return null
  }
}
