import { describe, it, expect } from 'vitest'
import { collectionDisplayName } from './collection-name'

describe('collectionDisplayName', () => {
  it('capitalises a single word', () => {
    expect(collectionDisplayName('floating')).toBe('Floating')
  })

  it('turns hyphens and underscores into spaces, in sentence case', () => {
    expect(collectionDisplayName('sketch-strip')).toBe('Sketch strip')
    expect(collectionDisplayName('blog_posts')).toBe('Blog posts')
  })

  it('splits camelCase names into words', () => {
    expect(collectionDisplayName('caseStudies')).toBe('Case studies')
  })

  it('keeps an all-caps word', () => {
    expect(collectionDisplayName('faq-UK')).toBe('Faq UK')
  })
})
