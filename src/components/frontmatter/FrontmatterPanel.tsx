import React from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useEditorStore } from '../../store/editorStore'
import { useProjectStore } from '../../store/projectStore'
import { useCollectionsQuery } from '../../hooks/queries/useCollectionsQuery'
import { useBodyEditorHidden } from '../../hooks/editor/useBodyEditorHidden'
import { deserializeCompleteSchema } from '../../lib/schema'
import { camelCaseToTitleCase } from '../../lib/utils'
import { FrontmatterField } from './fields'
import { getEffectiveSettings } from '../../lib/project-registry/effective-settings'
import type { Collection } from '@/types'
import { cn } from '../../lib/utils'

interface FrontmatterPanelProps {
  /**
   * Where this copy of the form is. The form shows in the right sidebar, or,
   * for a collection that hides the body editor, in the main area instead, so
   * an entry that's only fields gets the room the editor would have had. Both
   * copies stay mounted, and the one that isn't in use renders nothing.
   */
  placement?: 'sidebar' | 'main'
}

export const FrontmatterPanel: React.FC<FrontmatterPanelProps> = ({
  placement = 'sidebar',
}) => {
  const inMain = placement === 'main'
  const bodyHidden = useBodyEditorHidden()
  // Object subscriptions need shallow to prevent re-renders on reference changes
  const currentFile = useEditorStore(useShallow(state => state.currentFile))
  const frontmatter = useEditorStore(useShallow(state => state.frontmatter))
  const projectPath = useProjectStore(state => state.projectPath)
  const currentProjectSettings = useProjectStore(
    useShallow(state => state.currentProjectSettings)
  )

  // Use TanStack Query to fetch collections
  const { data: collections = [] } = useCollectionsQuery(
    projectPath,
    currentProjectSettings
  )

  // Get schema for current collection
  const currentCollection: Collection | null = currentFile
    ? collections.find(c => c.name === currentFile.collection) || null
    : null

  // Get schema from Rust backend
  const schema = React.useMemo(() => {
    if (!currentCollection?.complete_schema) return null

    const parsed = deserializeCompleteSchema(currentCollection.complete_schema)

    return parsed
  }, [currentCollection])

  // Get all fields to display
  const allFields = React.useMemo(() => {
    if (schema) {
      // Get title field name from collection-specific settings
      const effectiveSettings = currentFile
        ? getEffectiveSettings(currentProjectSettings, currentFile.collection)
        : getEffectiveSettings(currentProjectSettings)
      const titleFieldName = effectiveSettings.frontmatterMappings.title

      // Start with all schema fields. Schema defaults are only shown as a hint
      // (FieldWrapper), never put into frontmatter: anything in frontmatter gets
      // saved, which would write values the author never set.
      const schemaFields = schema.fields.map(field => ({
        fieldName: field.name,
        schemaField: field,
        value: frontmatter[field.name],
      }))

      // Reorder: title field first, then other schema fields in order
      const titleField = schemaFields.find(f => f.fieldName === titleFieldName)
      const otherSchemaFields = schemaFields.filter(
        f => f.fieldName !== titleFieldName
      )
      const orderedSchemaFields = titleField
        ? [titleField, ...otherSchemaFields]
        : schemaFields

      // Add any extra frontmatter fields that aren't in the schema
      const schemaFieldNames = new Set(schema.fields.map(f => f.name))

      // Filter out parent object keys if their nested properties exist in schema
      // e.g., exclude "metadata" if schema has "metadata.category", "metadata.priority", etc.
      const extraFields = Object.keys(frontmatter)
        .filter(key => {
          // If the key is in the schema, it's not an extra field
          if (schemaFieldNames.has(key)) return false

          // Check if this key is a parent path for any schema fields
          // e.g., if key is "metadata" and schema has "metadata.category", exclude it
          const isParentPath = schema.fields.some(f =>
            f.name.startsWith(`${key}.`)
          )
          if (isParentPath) return false

          return true
        })
        .sort()
        .map(fieldName => ({
          fieldName,
          schemaField: undefined,
          value: frontmatter[fieldName],
        }))

      return [...orderedSchemaFields, ...extraFields]
    } else {
      // No schema available, just show existing frontmatter fields
      return Object.keys(frontmatter).map(fieldName => ({
        fieldName,
        schemaField: undefined,
        value: frontmatter[fieldName],
      }))
    }
  }, [frontmatter, schema, currentProjectSettings, currentFile])

  // Group fields by parent path for nested object rendering
  const groupedFields = React.useMemo(() => {
    const groups: Map<string | null, typeof allFields> = new Map()

    for (const field of allFields) {
      const parentPath = field.schemaField?.parentPath ?? null
      if (!groups.has(parentPath)) {
        groups.set(parentPath, [])
      }
      groups.get(parentPath)!.push(field)
    }

    return groups
  }, [allFields])

  // Only one copy shows fields, so ids such as the title field's stay unique
  if (inMain !== bodyHidden) return null

  return (
    // data-frontmatter-panel: where focusNewFile finds a new entry's fields
    <div className="flex h-full flex-col" data-frontmatter-panel={placement}>
      <div
        className={cn('flex-1 overflow-y-auto', inMain ? 'px-6 py-10' : 'p-4')}
      >
        <div className={inMain ? 'mx-auto w-full max-w-[680px]' : undefined}>
          {currentFile ? (
            allFields.length > 0 ? (
              <div className="space-y-6">
                {/* Render top-level SCHEMA fields only */}
                {groupedFields
                  .get(null)
                  ?.filter(({ schemaField }) => schemaField !== undefined)
                  .map(({ fieldName, schemaField }) => (
                    <FrontmatterField
                      key={fieldName}
                      name={fieldName}
                      label={camelCaseToTitleCase(fieldName)}
                      field={schemaField}
                      collectionName={currentFile.collection}
                    />
                  ))}

                {/* Render nested field groups */}
                {Array.from(groupedFields.entries())
                  .filter(([parentPath]) => parentPath !== null)
                  .map(([parentPath, fields]) => (
                    <div key={parentPath} className="space-y-4">
                      {/* Parent section header */}
                      <h3 className="pt-2 text-sm font-medium text-foreground">
                        {camelCaseToTitleCase(
                          parentPath!.split('.').pop() || parentPath!
                        )}
                      </h3>

                      {/* Nested fields with indentation */}
                      <div className="space-y-4 border-l-2 border-border pl-4">
                        {fields.map(({ fieldName, schemaField }) => (
                          <FrontmatterField
                            key={fieldName}
                            name={fieldName}
                            label={
                              schemaField?.label ||
                              camelCaseToTitleCase(
                                fieldName.split('.').pop() || fieldName
                              )
                            }
                            field={schemaField}
                            collectionName={currentFile.collection}
                          />
                        ))}
                      </div>
                    </div>
                  ))}

                {/* Render extra fields (not in schema) at the very end, alphabetically */}
                {groupedFields
                  .get(null)
                  ?.filter(({ schemaField }) => schemaField === undefined)
                  .map(({ fieldName, schemaField }) => (
                    <FrontmatterField
                      key={fieldName}
                      name={fieldName}
                      label={camelCaseToTitleCase(fieldName)}
                      field={schemaField}
                      collectionName={currentFile.collection}
                    />
                  ))}
              </div>
            ) : (
              <div className="py-8 text-center">
                <p className="text-sm text-muted-foreground">
                  No frontmatter fields found.
                </p>
              </div>
            )
          ) : (
            <div className="py-12 text-center">
              <p className="text-sm text-muted-foreground">
                Select an entry to see its details.
              </p>
            </div>
          )}
          {inMain && currentFile && (
            <p className="mt-10 text-xs text-muted-foreground">
              Entries in this collection are only these fields. To write text
              here too, change Body Text in this collection&apos;s settings.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
