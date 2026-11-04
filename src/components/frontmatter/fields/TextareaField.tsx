import React from 'react'
import { useEditorStore } from '../../../store/editorStore'
import { getNestedValue } from '../../../lib/object-utils'
import { AutoExpandingTextarea } from '../../ui/auto-expanding-textarea'
import { valueToString } from '../utils'
import { CopyAsSlugLink } from './CopyAsSlugLink'
import { UpdateFileNameHint } from './UpdateFileNameHint'
import { FieldWrapper } from './FieldWrapper'
import { FormInUseContext } from '../form-in-use'
import type { FieldProps } from '../../../types/common'
import type { SchemaField } from '../../../lib/schema'

interface TextareaFieldProps extends FieldProps {
  placeholder?: string
  minRows?: number
  maxRows?: number
  field?: SchemaField
  showCopyAsSlug?: boolean
  showFileName?: boolean
}

export const TextareaField: React.FC<TextareaFieldProps> = ({
  name,
  label,
  placeholder,
  className,
  minRows = 2,
  maxRows = 6,
  required,
  field,
  showCopyAsSlug = false,
  showFileName = false,
}) => {
  const value = useEditorStore(state => getNestedValue(state.frontmatter, name))
  const updateFrontmatterField = useEditorStore(
    state => state.updateFrontmatterField
  )
  const generatedId = React.useId()
  // The fixed id lets focusNewFile find the title, so only the copy of the
  // form in use has it
  const formInUse = React.use(FormInUseContext)
  const id =
    name === 'title' && formInUse ? 'frontmatter-title-field' : generatedId

  return (
    <FieldWrapper
      label={label}
      htmlFor={id}
      required={required}
      description={
        field && 'description' in field ? field.description : undefined
      }
      defaultValue={field?.default}
      constraints={field?.constraints}
      currentValue={value}
    >
      <AutoExpandingTextarea
        id={id}
        placeholder={placeholder || `Enter ${label.toLowerCase()}...`}
        className={className}
        minRows={minRows}
        maxRows={maxRows}
        value={valueToString(value)}
        onChange={e => updateFrontmatterField(name, e.target.value)}
      />
      {showFileName && <UpdateFileNameHint />}
      {showCopyAsSlug && <CopyAsSlugLink text={valueToString(value)} />}
    </FieldWrapper>
  )
}
