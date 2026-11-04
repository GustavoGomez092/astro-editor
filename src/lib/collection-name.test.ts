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

  it('capitalises a standalone i as a word, wherever it is', () => {
    expect(collectionDisplayName('what-i-bring')).toBe('What I bring')
    expect(collectionDisplayName('things_i_make')).toBe('Things I make')
    expect(collectionDisplayName('i-wrote-this')).toBe('I wrote this')
    expect(collectionDisplayName('whatIBring')).toBe('What I bring')
    expect(collectionDisplayName('whatIDo')).toBe('What I do')
  })

  it('leaves an i inside a word alone', () => {
    expect(collectionDisplayName('kind-words')).toBe('Kind words')
    expect(collectionDisplayName('ideas-in-progress')).toBe('Ideas in progress')
  })

  it('keeps plural acronyms as one word', () => {
    expect(collectionDisplayName('FAQs')).toBe('Faqs')
    expect(collectionDisplayName('IDs')).toBe('Ids')
    expect(collectionDisplayName('URLs')).toBe('Urls')
    expect(collectionDisplayName('team-FAQs')).toBe('Team faqs')
    expect(collectionDisplayName('myIDs')).toBe('My ids')
  })

  it('keeps an all-caps word', () => {
    expect(collectionDisplayName('faq-UK')).toBe('Faq UK')
  })
})
