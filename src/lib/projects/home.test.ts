import { describe, it, expect } from 'vitest'
import {
  SEARCH_THRESHOLD,
  firstName,
  greetingFor,
  nextCardIndex,
  recentSites,
  showSearch,
  siteInitial,
} from './home'
import type { ProjectMetadata } from '../project-registry/types'

const at = (hour: number) => new Date(2026, 10, 4, hour, 30)

describe('greetingFor', () => {
  it('follows the time of day and uses the first name', () => {
    expect(greetingFor(at(8), 'Gustavo Gomez')).toBe('Good morning, Gustavo')
    expect(greetingFor(at(12), 'Gustavo Gomez')).toBe('Good afternoon, Gustavo')
    expect(greetingFor(at(17), 'Gustavo')).toBe('Good afternoon, Gustavo')
    expect(greetingFor(at(18), 'Gustavo')).toBe('Good evening, Gustavo')
    expect(greetingFor(at(2), 'Gustavo')).toBe('Good evening, Gustavo')
  })

  it('says Welcome back without a name', () => {
    expect(greetingFor(at(9), null)).toBe('Welcome back')
    expect(greetingFor(at(9), undefined)).toBe('Welcome back')
    expect(greetingFor(at(9), '   ')).toBe('Welcome back')
  })
})

describe('firstName', () => {
  it('is the first word of the name', () => {
    expect(firstName('  Kevin  Robinson ')).toBe('Kevin')
    expect(firstName('🌴 Kevin Robinson')).toBe('Kevin')
    expect(firstName('✨  ')).toBeNull()
    expect(firstName('')).toBeNull()
    expect(firstName(null)).toBeNull()
  })
})

describe('showSearch', () => {
  it('appears only with more than six sites', () => {
    expect(SEARCH_THRESHOLD).toBe(6)
    expect(showSearch(0)).toBe(false)
    expect(showSearch(6)).toBe(false)
    expect(showSearch(7)).toBe(true)
  })
})

describe('siteInitial', () => {
  it('is the folder name’s first letter, upper-cased', () => {
    expect(siteInitial('/Users/k/Sites/blog-starter')).toBe('B')
    expect(siteInitial('/x/_hidden')).toBe('_')
  })
})

describe('nextCardIndex', () => {
  // Three columns, seven cards:  0 1 2 / 3 4 5 / 6
  it('moves left and right, stopping at the ends', () => {
    expect(nextCardIndex(1, 7, 3, 'ArrowRight')).toBe(2)
    expect(nextCardIndex(1, 7, 3, 'ArrowLeft')).toBe(0)
    expect(nextCardIndex(0, 7, 3, 'ArrowLeft')).toBe(0)
    expect(nextCardIndex(6, 7, 3, 'ArrowRight')).toBe(6)
  })

  it('moves up and down a row, staying put at the edge', () => {
    expect(nextCardIndex(1, 7, 3, 'ArrowDown')).toBe(4)
    expect(nextCardIndex(4, 7, 3, 'ArrowUp')).toBe(1)
    expect(nextCardIndex(1, 7, 3, 'ArrowUp')).toBe(1)
    expect(nextCardIndex(5, 7, 3, 'ArrowDown')).toBe(6)
  })

  it('goes to the first and last with Home and End', () => {
    expect(nextCardIndex(3, 7, 3, 'Home')).toBe(0)
    expect(nextCardIndex(3, 7, 3, 'End')).toBe(6)
  })

  it('ignores other keys', () => {
    expect(nextCardIndex(3, 7, 3, 'a')).toBeNull()
  })
})

const project = (name: string, lastOpened: string): ProjectMetadata => ({
  id: name,
  name,
  path: `/Users/k/${name}`,
  lastOpened,
  created: lastOpened,
})

describe('recentSites', () => {
  it('is newest first and at most five', () => {
    const all = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name, i) =>
      project(name, `2026-11-0${i + 1}T10:00:00Z`)
    )
    expect(recentSites(all).map(p => p.name)).toEqual(['g', 'f', 'e', 'd', 'c'])
  })
})
