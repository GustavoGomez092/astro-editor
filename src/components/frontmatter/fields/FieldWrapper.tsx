import React from 'react'
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldContent,
} from '@/components/ui/field'
import type { FieldConstraints } from '../../../lib/schema'

interface FieldWrapperProps {
  label: string
  /** Id of a text control: clicking the label focuses it */
  htmlFor?: string
  /** Id for the label, for button controls that name themselves with aria-labelledby (htmlFor would click them) */
  labelId?: string
  required?: boolean
  description?: string
  defaultValue?: unknown
  constraints?: FieldConstraints
  layout?: 'vertical' | 'horizontal'
  children: React.ReactNode
  currentValue?: unknown
  hideDefaultValue?: boolean
}

export const FieldWrapper: React.FC<FieldWrapperProps> = ({
  label,
  htmlFor,
  labelId,
  required,
  description,
  defaultValue,
  constraints,
  layout = 'vertical',
  children,
  currentValue,
  hideDefaultValue = false,
}) => {
  const isEmpty =
    currentValue === undefined || currentValue === null || currentValue === ''

  const showDefault = !hideDefaultValue && defaultValue !== undefined && isEmpty

  const metadataText = formatMetadata(
    constraints,
    showDefault ? defaultValue : undefined,
    description
  )

  return (
    <Field orientation={layout}>
      <FieldLabel htmlFor={htmlFor} id={labelId}>
        {label}
        {required && <span className="ml-1 text-required">*</span>}
      </FieldLabel>
      <FieldContent>
        {children}
        {description && <FieldDescription>{description}</FieldDescription>}
        {metadataText && (
          <FieldDescription className="text-xs">
            {metadataText}
          </FieldDescription>
        )}
      </FieldContent>
    </Field>
  )
}

/**
 * The numbers a description mentions, so a hint doesn't repeat them. A minus
 * sign counts unless it follows a digit, where it's a range ("0-95")
 */
function numbersIn(text?: string): Set<number> {
  const matches = (text ?? '').matchAll(/(?:^|[^\d.])(-?\d+(?:\.\d+)?)/g)
  return new Set([...matches].map(match => Number(match[1])))
}

/** An empty default (`''`, `[]`, `{}`) says nothing, so it isn't shown */
function isEmptyDefault(value: unknown): boolean {
  if (value === '' || value === null) return true
  if (Array.isArray(value)) return value.length === 0
  return typeof value === 'object' && Object.keys(value).length === 0
}

function formatMetadata(
  constraints?: FieldConstraints,
  defaultValue?: unknown,
  description?: string
): string | null {
  const parts: string[] = []
  // A bounds hint is left out when the description already gives every
  // number in it ("in % of the section (0–95)")
  const mentioned = numbersIn(description)
  const stated = (...bounds: number[]) =>
    bounds.every(bound => mentioned.has(bound))

  if (constraints) {
    // Numeric constraints. Exclusive bounds (`gt`, `lt`) show as "> 0"
    const { min, max, minExclusive, maxExclusive } = constraints
    if (
      min !== undefined &&
      max !== undefined &&
      !minExclusive &&
      !maxExclusive
    ) {
      if (!stated(min, max)) parts.push(`${min}–${max}`)
    } else {
      if (min !== undefined && !stated(min)) {
        parts.push(minExclusive ? `> ${min}` : `Min: ${min}`)
      }
      if (max !== undefined && !stated(max)) {
        parts.push(maxExclusive ? `< ${max}` : `Max: ${max}`)
      }
    }

    // String length constraints
    const { minLength, maxLength } = constraints
    if (minLength !== undefined && maxLength !== undefined) {
      if (!stated(minLength, maxLength)) {
        parts.push(`${minLength}–${maxLength} characters`)
      }
    } else if (minLength !== undefined) {
      if (!stated(minLength)) parts.push(`Min ${minLength} chars`)
    } else if (maxLength !== undefined) {
      if (!stated(maxLength)) parts.push(`Max ${maxLength} chars`)
    }

    // Array length constraints
    const items = (count: number) => (count === 1 ? 'item' : 'items')
    if (
      constraints.minItems !== undefined &&
      constraints.minItems === constraints.maxItems
    ) {
      parts.push(
        `Exactly ${constraints.minItems} ${items(constraints.minItems)}`
      )
    } else if (
      constraints.minItems !== undefined &&
      constraints.maxItems !== undefined
    ) {
      parts.push(`${constraints.minItems}–${constraints.maxItems} items`)
    } else if (constraints.minItems !== undefined) {
      parts.push(
        `At least ${constraints.minItems} ${items(constraints.minItems)}`
      )
    } else if (constraints.maxItems !== undefined) {
      parts.push(`Up to ${constraints.maxItems} ${items(constraints.maxItems)}`)
    }

    // Format hints
    if (constraints.format) {
      const formatLabels: Record<string, string> = {
        email: 'Email format',
        uri: 'URL format',
        'date-time': 'Date/time format',
        date: 'Date format',
      }
      const label = formatLabels[constraints.format]
      if (label) parts.push(label)
    }

    // Pattern (only if it's simple enough to show)
    if (constraints.pattern && constraints.pattern.length < 30) {
      parts.push(`Pattern: ${constraints.pattern}`)
    }
  }

  // Default value
  if (defaultValue !== undefined && !isEmptyDefault(defaultValue)) {
    const defaultStr =
      typeof defaultValue === 'string'
        ? defaultValue
        : JSON.stringify(defaultValue)
    parts.push(`Default: ${defaultStr}`)
  }

  return parts.length > 0 ? parts.join(' • ') : null
}
