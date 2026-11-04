// Saving frontmatter without changing a file that didn't really change.
// Writing the values back reformats the YAML (quotes, spacing, order), so an
// edit that was undone, like a toggle switched on and off, would still show
// up as a change to publish. When the values are back to what was on disk,
// the original text is written instead.

type Values = Record<string, unknown>

/** The frontmatter on disk: its values and the exact text they came from. */
export interface FrontmatterBaseline {
  values: Values
  raw: string
}

/** Deep equality for parsed YAML values; key order doesn't matter. */
export function sameValues(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameValues(item, b[index]))
    )
  }
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  ) {
    return false
  }
  const left = a as Values
  const right = b as Values
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every(key => key in right && sameValues(left[key], right[key]))
  )
}

/**
 * What a save passes for the frontmatter: the values to write, or the text to
 * keep. The text on disk is kept when the frontmatter wasn't edited, and the
 * baseline's text when the edits ended where they started.
 */
export function frontmatterToWrite({
  frontmatter,
  isFrontmatterDirty,
  rawFrontmatter,
  frontmatterBaseline,
}: {
  frontmatter: Values
  isFrontmatterDirty: boolean
  rawFrontmatter: string
  frontmatterBaseline: FrontmatterBaseline | null
}): { frontmatter: Values | null; rawFrontmatter: string | null } {
  if (!isFrontmatterDirty) return { frontmatter: null, rawFrontmatter }
  if (
    frontmatterBaseline &&
    sameValues(frontmatter, frontmatterBaseline.values)
  ) {
    return { frontmatter: null, rawFrontmatter: frontmatterBaseline.raw }
  }
  return { frontmatter, rawFrontmatter: null }
}

/**
 * The baseline after the open file loads from disk. It's the first load
 * after opening, and moves to any later load that isn't the reload of our own
 * save (whose values are the ones we last wrote): a change made outside the
 * app, or by git, becomes the new starting point.
 */
export function nextFrontmatterBaseline(
  current: FrontmatterBaseline | null,
  loaded: FrontmatterBaseline,
  lastWritten: Values | null
): FrontmatterBaseline {
  if (current === null) return loaded
  const ownSave = lastWritten !== null && sameValues(loaded.values, lastWritten)
  return ownSave ? current : loaded
}
