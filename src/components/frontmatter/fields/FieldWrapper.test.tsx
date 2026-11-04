import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FieldWrapper } from './FieldWrapper'
import type { FieldConstraints } from '../../../lib/schema'

describe('FieldWrapper', () => {
  describe('vertical layout', () => {
    it('renders label and children', () => {
      render(
        <FieldWrapper label="Test Field">
          <input data-testid="test-input" />
        </FieldWrapper>
      )

      expect(screen.getByText('Test Field')).toBeInTheDocument()
      expect(screen.getByTestId('test-input')).toBeInTheDocument()
    })

    it('shows required asterisk when required', () => {
      render(
        <FieldWrapper label="Test Field" required>
          <input />
        </FieldWrapper>
      )

      expect(screen.getByText('*')).toBeInTheDocument()
    })

    it('displays description when provided', () => {
      render(
        <FieldWrapper
          label="Test Field"
          description="This is a helpful description"
        >
          <input />
        </FieldWrapper>
      )

      expect(
        screen.getByText('This is a helpful description')
      ).toBeInTheDocument()
    })
  })

  describe('horizontal layout', () => {
    it('renders with horizontal layout for toggles', () => {
      const { container } = render(
        <FieldWrapper label="Test Field" layout="horizontal">
          <div data-testid="toggle">Toggle</div>
        </FieldWrapper>
      )

      // Check that the Field has horizontal orientation
      const field = container.querySelector('[data-orientation="horizontal"]')
      expect(field).toBeInTheDocument()
      expect(screen.getByTestId('toggle')).toBeInTheDocument()
    })
  })

  describe('constraint formatting', () => {
    it('formats numeric min-max range', () => {
      const constraints: FieldConstraints = { min: 1, max: 100 }

      render(
        <FieldWrapper label="Test" constraints={constraints} currentValue={50}>
          <input />
        </FieldWrapper>
      )

      expect(screen.getByText('1–100')).toBeInTheDocument()
    })

    it('formats min only', () => {
      const constraints: FieldConstraints = { min: 10 }

      render(
        <FieldWrapper label="Test" constraints={constraints} currentValue={15}>
          <input />
        </FieldWrapper>
      )

      expect(screen.getByText('Min: 10')).toBeInTheDocument()
    })

    it('formats exclusive bounds as comparisons', () => {
      const constraints: FieldConstraints = {
        min: 0,
        max: 10,
        minExclusive: true,
        maxExclusive: true,
      }

      render(
        <FieldWrapper label="Test" constraints={constraints} currentValue={5}>
          <input />
        </FieldWrapper>
      )

      expect(screen.getByText('> 0 • < 10')).toBeInTheDocument()
    })

    it('formats max only', () => {
      const constraints: FieldConstraints = { max: 999 }

      render(
        <FieldWrapper label="Test" constraints={constraints} currentValue={50}>
          <input />
        </FieldWrapper>
      )

      expect(screen.getByText('Max: 999')).toBeInTheDocument()
    })

    it('formats string length constraints as range', () => {
      const constraints: FieldConstraints = { minLength: 3, maxLength: 500 }

      render(
        <FieldWrapper
          label="Test"
          constraints={constraints}
          currentValue="hello"
        >
          <input />
        </FieldWrapper>
      )

      expect(screen.getByText('3–500 characters')).toBeInTheDocument()
    })

    it('formats minLength only', () => {
      const constraints: FieldConstraints = { minLength: 5 }

      render(
        <FieldWrapper
          label="Test"
          constraints={constraints}
          currentValue="hello"
        >
          <input />
        </FieldWrapper>
      )

      expect(screen.getByText('Min 5 chars')).toBeInTheDocument()
    })

    // A list's size, in items rather than characters
    it.each<[FieldConstraints, string]>([
      [{ maxItems: 3 }, 'Up to 3 items'],
      [{ minItems: 1 }, 'At least 1 item'],
      [{ minItems: 2, maxItems: 5 }, '2–5 items'],
      [{ minItems: 1, maxItems: 1 }, 'Exactly 1 item'],
    ])('formats %o as "%s"', (constraints, text) => {
      render(
        <FieldWrapper
          label="Test"
          constraints={constraints}
          currentValue={['a']}
        >
          <input />
        </FieldWrapper>
      )

      expect(screen.getByText(text)).toBeInTheDocument()
    })

    it('formats maxLength only', () => {
      const constraints: FieldConstraints = { maxLength: 200 }

      render(
        <FieldWrapper
          label="Test"
          constraints={constraints}
          currentValue="test"
        >
          <input />
        </FieldWrapper>
      )

      expect(screen.getByText('Max 200 chars')).toBeInTheDocument()
    })

    it('formats email format constraint', () => {
      const constraints: FieldConstraints = { format: 'email' }

      render(
        <FieldWrapper
          label="Test"
          constraints={constraints}
          currentValue="test@example.com"
        >
          <input />
        </FieldWrapper>
      )

      expect(screen.getByText('Email format')).toBeInTheDocument()
    })

    it('formats URI format constraint', () => {
      const constraints: FieldConstraints = { format: 'uri' }

      render(
        <FieldWrapper
          label="Test"
          constraints={constraints}
          currentValue="https://example.com"
        >
          <input />
        </FieldWrapper>
      )

      expect(screen.getByText('URL format')).toBeInTheDocument()
    })

    it('shows pattern for short patterns', () => {
      const constraints: FieldConstraints = { pattern: '^[A-Z]{3}$' }

      render(
        <FieldWrapper label="Test" constraints={constraints} currentValue="ABC">
          <input />
        </FieldWrapper>
      )

      expect(screen.getByText('Pattern: ^[A-Z]{3}$')).toBeInTheDocument()
    })

    it('hides pattern for long patterns', () => {
      const constraints: FieldConstraints = {
        pattern: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$',
      }

      render(
        <FieldWrapper
          label="Test"
          constraints={constraints}
          currentValue="test@example.com"
        >
          <input />
        </FieldWrapper>
      )

      expect(screen.queryByText(/Pattern:/)).not.toBeInTheDocument()
    })

    it('combines multiple constraints with bullet separator', () => {
      const constraints: FieldConstraints = {
        min: 1,
        max: 100,
        format: 'email',
      }

      render(
        <FieldWrapper label="Test" constraints={constraints} currentValue={50}>
          <input />
        </FieldWrapper>
      )

      expect(screen.getByText('1–100 • Email format')).toBeInTheDocument()
    })
  })

  describe('default value display', () => {
    it('shows default value when field is empty', () => {
      render(
        <FieldWrapper
          label="Test"
          defaultValue="default text"
          currentValue={undefined}
        >
          <input />
        </FieldWrapper>
      )

      expect(screen.getByText('Default: default text')).toBeInTheDocument()
    })

    it('hides default value when field has value', () => {
      render(
        <FieldWrapper
          label="Test"
          defaultValue="default text"
          currentValue="actual value"
        >
          <input />
        </FieldWrapper>
      )

      expect(screen.queryByText(/Default:/)).not.toBeInTheDocument()
    })

    it('shows default value when field is empty string', () => {
      render(
        <FieldWrapper label="Test" defaultValue="default text" currentValue="">
          <input />
        </FieldWrapper>
      )

      expect(screen.getByText('Default: default text')).toBeInTheDocument()
    })

    it('shows default value when field is null', () => {
      render(
        <FieldWrapper
          label="Test"
          defaultValue="default text"
          currentValue={null}
        >
          <input />
        </FieldWrapper>
      )

      expect(screen.getByText('Default: default text')).toBeInTheDocument()
    })

    it('formats non-string default values', () => {
      render(
        <FieldWrapper label="Test" defaultValue={42} currentValue={undefined}>
          <input />
        </FieldWrapper>
      )

      expect(screen.getByText('Default: 42')).toBeInTheDocument()
    })

    it('formats object default values as JSON', () => {
      render(
        <FieldWrapper
          label="Test"
          defaultValue={{ key: 'value' }}
          currentValue={undefined}
        >
          <input />
        </FieldWrapper>
      )

      expect(screen.getByText('Default: {"key":"value"}')).toBeInTheDocument()
    })

    it('hides default value when hideDefaultValue is true', () => {
      render(
        <FieldWrapper
          label="Test"
          defaultValue="default text"
          currentValue={undefined}
          hideDefaultValue={true}
        >
          <input />
        </FieldWrapper>
      )

      expect(screen.queryByText(/Default:/)).not.toBeInTheDocument()
    })

    it('still shows default value when hideDefaultValue is false', () => {
      render(
        <FieldWrapper
          label="Test"
          defaultValue="default text"
          currentValue={undefined}
          hideDefaultValue={false}
        >
          <input />
        </FieldWrapper>
      )

      expect(screen.getByText('Default: default text')).toBeInTheDocument()
    })
  })

  describe('hints the description already gives', () => {
    const hint = (props: {
      constraints?: FieldConstraints
      description?: string
      defaultValue?: unknown
    }) => {
      const { container } = render(
        <FieldWrapper label="Left" {...props}>
          <input />
        </FieldWrapper>
      )
      return container.querySelectorAll('[data-slot="field-description"]')
    }

    it('leaves out a range the description states', () => {
      const shown = hint({
        constraints: { min: 0, max: 95 },
        description: 'Distance from the left edge, in % (0–95).',
      })
      expect(shown).toHaveLength(1)
      expect(screen.queryByText('0–95')).not.toBeInTheDocument()
    })

    it('keeps a range the description only half states', () => {
      hint({
        constraints: { min: 0, max: 95 },
        description: 'Up to 95% from the left.',
      })
      expect(screen.getByText('0–95')).toBeInTheDocument()
    })

    it('leaves out a length limit the description states', () => {
      hint({
        constraints: { maxLength: 200 },
        description: 'A summary of 200 characters or fewer.',
      })
      expect(screen.queryByText('Max 200 chars')).not.toBeInTheDocument()
    })

    it('reads a minus sign as part of the number', () => {
      hint({
        constraints: { min: -10, max: 10 },
        description: 'Tilt in degrees, from -10 to 10.',
      })
      expect(screen.queryByText('-10–10')).not.toBeInTheDocument()
    })

    it("doesn't count a positive number as stating a negative bound", () => {
      hint({ constraints: { min: -5 }, description: 'At least 5 px.' })
      expect(screen.getByText('Min: -5')).toBeInTheDocument()
    })

    it('reads a hyphen between numbers as a range, not a sign', () => {
      hint({
        constraints: { min: 0, max: 95 },
        description: 'In % of the section (0-95).',
      })
      expect(screen.queryByText('0–95')).not.toBeInTheDocument()
    })

    it("doesn't match a number inside a longer one", () => {
      hint({ constraints: { max: 95 }, description: 'Around 950 px wide.' })
      expect(screen.getByText('Max: 95')).toBeInTheDocument()
    })
  })

  describe('empty defaults', () => {
    const renderDefault = (defaultValue: unknown) =>
      render(
        <FieldWrapper label="Field" defaultValue={defaultValue}>
          <input />
        </FieldWrapper>
      )

    it.each([[''], [[]], [{}]])('hides an empty default (%j)', value => {
      renderDefault(value)
      expect(screen.queryByText(/Default:/)).not.toBeInTheDocument()
    })

    it('shows a default with a value', () => {
      renderDefault('draft')
      expect(screen.getByText('Default: draft')).toBeInTheDocument()
    })
  })
})
