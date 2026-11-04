/**
 * A collection's name as words, for showing in the UI: `floating` →
 * "Floating", `sketch-strip` → "Sketch strip", `caseStudies` → "Case
 * studies". The word "I" stays a capital: `what-i-bring` → "What I bring".
 * The name itself (the folder and the config key) is unchanged.
 */
export function collectionDisplayName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // An acronym before a word: `whatIBring`, `HTMLGuide`
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word, index) => {
      if (word.length > 1 && word === word.toUpperCase()) return word
      const lower = word.toLowerCase()
      if (lower === 'i') return 'I'
      return index === 0
        ? lower.charAt(0).toUpperCase() + lower.slice(1)
        : lower
    })
  return words.join(' ') || name
}
