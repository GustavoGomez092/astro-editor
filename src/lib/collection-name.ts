/**
 * A collection's name as words, for showing in the UI: `floating` →
 * "Floating", `sketch-strip` → "Sketch strip", `caseStudies` → "Case
 * studies". The word "I" stays a capital: `what-i-bring` → "What I bring".
 * The name itself (the folder and the config key) is unchanged.
 */
export function collectionDisplayName(name: string): string {
  const words = name
    // A lone I between camelCase words (`whatIBring`), but not the start of a
    // plural acronym (`myIDs`)
    .replace(/([a-z])I(?=[A-Z](?!s(?![a-z]))[a-z])/g, '$1 I ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
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
