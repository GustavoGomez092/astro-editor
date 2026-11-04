import { describe, it, expect } from 'vitest'
import type { DevServerState } from '@/lib/bindings'
import {
  firstErrorLine,
  isBusy,
  needsNode,
  previewTitle,
  statusLabel,
} from './index'

const state = (overrides: Partial<DevServerState>): DevServerState => ({
  status: 'stopped',
  url: null,
  command: null,
  pid: null,
  error: null,
  ...overrides,
})

describe('firstErrorLine', () => {
  it("takes the output's first error line", () => {
    expect(
      firstErrorLine(
        'The dev server stopped before it was ready.\n\n> echo Error && astro dev\nError: Cannot find module vite\nError: second'
      )
    ).toBe('Error: Cannot find module vite')
    expect(
      firstErrorLine(
        "Couldn't install the project's dependencies (npm ci).\n\nnpm ERR! network unreachable"
      )
    ).toBe('npm ERR! network unreachable')
  })

  it('falls back to the summary when no line looks like an error', () => {
    expect(firstErrorLine('The dev server stopped unexpectedly.\n\nbye')).toBe(
      'The dev server stopped unexpectedly.'
    )
    expect(firstErrorLine('\n  \nboom')).toBe('boom')
  })

  it('keeps the plain-words message when Node is missing', () => {
    expect(
      firstErrorLine(
        "Couldn't find npm. Install Node.js from https://nodejs.org, then try again.\n\nzsh:1: command not found: npm"
      )
    ).toBe(
      "Couldn't find npm. Install Node.js from https://nodejs.org, then try again."
    )
  })

  it('is null without an error', () => {
    expect(firstErrorLine(null)).toBeNull()
    expect(firstErrorLine('  \n')).toBeNull()
  })
})

describe('statusLabel', () => {
  it('describes each state for the status dot', () => {
    expect(statusLabel(state({ status: 'installing' }))).toBe(
      'Installing dependencies…'
    )
    expect(statusLabel(state({ status: 'starting' }))).toBe(
      'Starting the dev server…'
    )
    expect(
      statusLabel(state({ status: 'running', url: 'http://localhost:4321/' }))
    ).toBe('Running at http://localhost:4321/')
    expect(
      statusLabel(state({ status: 'external', url: 'http://localhost:4321/' }))
    ).toBe('Running in another window or terminal: http://localhost:4321/')
    expect(
      statusLabel(
        state({ status: 'error', error: 'Couldn’t find npm.\n\nzsh: npm' })
      )
    ).toBe('Couldn’t find npm.')
    expect(statusLabel(state({ status: 'stopped' }))).toBe('Stopped')
  })
})

describe('previewTitle', () => {
  it('names the command it will run', () => {
    expect(previewTitle(state({ command: 'npm run dev' }))).toBe(
      'Preview the site (npm run dev)'
    )
    expect(previewTitle(state({}))).toBe('Preview the site')
  })
})

describe('isBusy', () => {
  it('is true while installing or starting', () => {
    expect(isBusy('installing')).toBe(true)
    expect(isBusy('starting')).toBe(true)
    expect(isBusy('running')).toBe(false)
    expect(isBusy('error')).toBe(false)
  })
})

describe('needsNode', () => {
  it('spots the missing-Node error', () => {
    expect(
      needsNode(
        "Couldn't find npm. Install Node.js from https://nodejs.org, then try again."
      )
    ).toBe(true)
    expect(needsNode('The dev server stopped unexpectedly.')).toBe(false)
    expect(needsNode(null)).toBe(false)
  })
})
