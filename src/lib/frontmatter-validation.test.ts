import { describe, it, expect } from 'vitest'
import { fieldError, validateFrontmatter } from './frontmatter-validation'
import { FieldType, type SchemaField } from './schema'

const field = (
  name: string,
  type: FieldType,
  extra: Partial<SchemaField> = {}
): SchemaField => ({ name, label: name, type, required: false, ...extra })

const errorFor = (f: SchemaField, value: unknown) =>
  fieldError(f, value === undefined ? {} : { [f.name]: value })

describe('fieldError', () => {
  describe('required', () => {
    const title = field('title', FieldType.String, { required: true })

    it('flags a missing or empty required value', () => {
      expect(errorFor(title, undefined)).toBe('Required')
      expect(errorFor(title, '')).toBe('Required')
      expect(errorFor(title, null)).toBe('Required')
    })

    it('accepts a filled-in required value', () => {
      expect(errorFor(title, 'Hello')).toBeNull()
    })

    it('accepts false and an empty list as values', () => {
      const featured = field('featured', FieldType.Boolean, { required: true })
      const tags = field('tags', FieldType.Array, { required: true })
      expect(errorFor(featured, false)).toBeNull()
      expect(errorFor(tags, [])).toBeNull()
    })

    it("doesn't check anything else on an empty optional field", () => {
      const email = field('email', FieldType.Email)
      expect(errorFor(email, undefined)).toBeNull()
    })

    it('skips a nested required field when its parent object is absent', () => {
      const name = field('author.name', FieldType.String, {
        required: true,
        isNested: true,
        parentPath: 'author',
      })
      expect(fieldError(name, {})).toBeNull()
      expect(fieldError(name, { author: { bio: 'x' } })).toBe('Required')
      expect(fieldError(name, { author: { name: 'Ann' } })).toBeNull()
    })
  })

  describe('formats', () => {
    it('checks email addresses', () => {
      const email = field('email', FieldType.Email)
      expect(errorFor(email, 'kevin@example.com')).toBeNull()
      expect(errorFor(email, 'kevin@example')).toBe(
        'Enter an email address, like name@example.com'
      )
      expect(errorFor(email, 'not an email')).not.toBeNull()
    })

    it('checks an email format on a string field', () => {
      const contact = field('contact', FieldType.String, {
        constraints: { format: 'email' },
      })
      expect(errorFor(contact, 'nope')).not.toBeNull()
    })

    it('checks URLs', () => {
      const site = field('site', FieldType.URL)
      expect(errorFor(site, 'https://example.com/a?b=c')).toBeNull()
      expect(errorFor(site, 'example.com')).toBe(
        'Enter a full URL, like https://example.com'
      )
    })
  })

  describe('numbers', () => {
    const width = field('width', FieldType.Integer, {
      constraints: { min: 100, max: 2000 },
    })

    it('checks whole numbers', () => {
      expect(errorFor(width, 640)).toBeNull()
      expect(errorFor(width, 640.5)).toBe('Enter a whole number')
    })

    it('checks the bounds', () => {
      expect(errorFor(width, 99)).toBe('Must be at least 100')
      expect(errorFor(width, 2001)).toBe('Must be at most 2000')
      expect(errorFor(width, 100)).toBeNull()
      expect(errorFor(width, 2000)).toBeNull()
    })

    it('checks exclusive bounds', () => {
      const ratio = field('ratio', FieldType.Number, {
        constraints: { min: 0, max: 1, minExclusive: true, maxExclusive: true },
      })
      expect(errorFor(ratio, 0)).toBe('Must be more than 0')
      expect(errorFor(ratio, 1)).toBe('Must be less than 1')
      expect(errorFor(ratio, 0.5)).toBeNull()
    })

    it('flags a value that is not a number', () => {
      const left = field('left', FieldType.Number)
      expect(errorFor(left, 'ten')).toBe('Enter a number')
    })
  })

  describe('lengths', () => {
    it('checks text length', () => {
      const title = field('title', FieldType.String, {
        constraints: { minLength: 3, maxLength: 5 },
      })
      expect(errorFor(title, 'ab')).toBe('Must be at least 3 characters')
      expect(errorFor(title, 'abcdef')).toBe('Must be 5 characters or fewer')
      expect(errorFor(title, 'abcd')).toBeNull()
    })

    it('checks how many items a list has', () => {
      const tags = field('tags', FieldType.Array, {
        constraints: { minItems: 1, maxItems: 2 },
      })
      expect(errorFor(tags, [])).toBe('Add at least 1 item')
      expect(errorFor(tags, ['a', 'b', 'c'])).toBe('Use 2 items or fewer')
      expect(errorFor(tags, ['a'])).toBeNull()
    })
  })

  describe('enums', () => {
    it('checks the value is one of the options', () => {
      const size = field('size', FieldType.Enum, {
        enumValues: ['small', 'large'],
      })
      expect(errorFor(size, 'small')).toBeNull()
      expect(errorFor(size, 'medium')).toBe('Choose one of: small, large')
    })
  })
})

describe('validateFrontmatter', () => {
  it('returns a message for each field that needs attention', () => {
    const fields = [
      field('title', FieldType.String, { required: true }),
      field('email', FieldType.Email, { required: true }),
      field('width', FieldType.Integer, { constraints: { max: 10 } }),
      field('draft', FieldType.Boolean),
    ]

    expect(
      validateFrontmatter(fields, { email: 'nope', width: 11, draft: true })
    ).toEqual({
      title: 'Required',
      email: 'Enter an email address, like name@example.com',
      width: 'Must be at most 10',
    })
  })

  it('reads nested values by their dotted name', () => {
    const fields = [
      field('seo.score', FieldType.Integer, {
        isNested: true,
        parentPath: 'seo',
        constraints: { min: 1 },
      }),
    ]
    expect(validateFrontmatter(fields, { seo: { score: 0 } })).toEqual({
      'seo.score': 'Must be at least 1',
    })
  })
})
