// Renaming an entry's file to follow its title, the same way New File names a
// new one (`newFileName`): the title's slug, the same extension, and `-1`,
// `-2`, … added when the name is taken.

import { slugFromTitle } from '../slug'
import { newFileName } from './new-file'

const stemOf = (fileName: string) => fileName.replace(/\.[^.]+$/, '')

/** The title as text to name a file from, or '' when there's nothing usable */
export function titleText(title: unknown): string {
  return typeof title === 'string' ? title.trim() : ''
}

/**
 * Whether the file name already follows the title: its name is the title's
 * slug, or the slug with a `-1`, `-2`, … that a clash added. A title with no
 * letters or digits has nothing to name a file from, so it counts as matching
 * (the action isn't offered).
 */
export function fileNameMatchesTitle(
  title: unknown,
  fileName: string
): boolean {
  const slug = slugFromTitle(titleText(title))
  if (!slug) return true
  const stem = stemOf(fileName)
  return stem === slug || new RegExp(`^${escapeRegExp(slug)}-\\d+$`).test(stem)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The name to rename `currentFileName` to so it matches `title`, or null when
 * there's nothing to do: no usable title, or the name already follows it.
 * `siblingNames` are the file names in the same folder (the file itself may
 * be among them).
 */
export function renameTargetFor(
  title: unknown,
  currentFileName: string,
  siblingNames: Iterable<string>
): string | null {
  const text = titleText(title)
  if (!slugFromTitle(text) || fileNameMatchesTitle(text, currentFileName))
    return null

  const extension = currentFileName.includes('.')
    ? (currentFileName.split('.').pop() ?? 'md')
    : 'md'
  const others = new Set(
    [...siblingNames].filter(name => name !== currentFileName)
  )
  const target = newFileName(text, extension, others, '')
  return target
}

/**
 * The frontmatter with its `slug` set to the new slug, when it has a `slug`
 * that is text. Otherwise the same object: an entry without one doesn't get
 * one added.
 */
export function withSlugField(
  frontmatter: Record<string, unknown>,
  newFileNameValue: string
): Record<string, unknown> {
  if (typeof frontmatter.slug !== 'string') return frontmatter
  return { ...frontmatter, slug: stemOf(newFileNameValue) }
}
