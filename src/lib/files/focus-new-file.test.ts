import { afterEach, describe, expect, it } from 'vitest'
import { focusNewFile } from './focus-new-file'

function page(bodyEditor: 'shown' | 'hidden') {
  document.body.innerHTML = `
    <div data-body-editor="${bodyEditor}">
      <div class="cm-editor"><div class="cm-content" contenteditable="true" tabindex="0"></div></div>
    </div>
    <div data-frontmatter-panel>
      <label>Name<input id="frontmatter-name-field" /></label>
      <textarea id="frontmatter-title-field"></textarea>
    </div>`
}

describe('focusNewFile', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('focuses the editor for a titled entry when it shows the body', () => {
    page('shown')
    focusNewFile({ titleGiven: true })
    expect(document.activeElement).toBe(document.querySelector('.cm-content'))
  })

  it('focuses the first frontmatter field when the body editor is hidden', () => {
    page('hidden')
    focusNewFile({ titleGiven: true })
    expect(document.activeElement?.id).toBe('frontmatter-name-field')
  })

  it('focuses the title field when no title was given', () => {
    page('shown')
    focusNewFile({ titleGiven: false })
    expect(document.activeElement?.id).toBe('frontmatter-title-field')
  })
})
