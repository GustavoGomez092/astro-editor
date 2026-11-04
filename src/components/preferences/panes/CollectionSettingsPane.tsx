import React, { useMemo, useState } from 'react'
import { warn as logWarn } from '@tauri-apps/plugin-log'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldContent,
} from '@/components/ui/field'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { usePreferences } from '../../../hooks/usePreferences'
import { useCollectionsQuery } from '../../../hooks/queries/useCollectionsQuery'
import {
  hasCollectionSettings,
  withCollectionSort,
} from '../../../lib/project-registry/collection-settings'
import { deserializeCompleteSchema, FieldType } from '../../../lib/schema'
import type { SchemaField } from '../../../lib/schema'
import type { CollectionSettings } from '../../../lib/project-registry/types'
import { SettingsSection } from '../SettingsSection'
import { SettingStatus } from '../SettingStatus'
import {
  describeSort,
  explainCollectionSettings,
} from '../../../lib/project-registry/explain-settings'
import type { CollectionSort } from '../../../lib/project-registry/types'
import { useProjectStore } from '../../../store/projectStore'
import {
  checkCollectionFolder,
  getEffectiveContentDirectory,
} from '../../../lib/project-registry/path-resolution'
import { toast } from '../../../lib/toast'
import { PreferencesTextInput } from '../PreferencesTextInput'
import { DocsLink } from '../DocsLink'
import { DOCS_URLS } from '../../../lib/docs-urls'
import { collectionDisplayName } from '../../../lib/collection-name'

/**
 * The orders the file list offers for a collection, each way round: the
 * Default, titles, file names, each date field, `order` when it's a number,
 * and last changed
 */
function sortChoices(fields: SchemaField[]): CollectionSort[] {
  const modes = [
    'title',
    'filename',
    ...fields.filter(f => f.type === FieldType.Date).map(f => `date-${f.name}`),
    ...(fields.some(
      f =>
        f.name === 'order' &&
        (f.type === FieldType.Number || f.type === FieldType.Integer)
    )
      ? ['order']
      : []),
    'modified',
  ]
  return [
    { mode: 'default', direction: 'desc' },
    ...modes.flatMap(mode => [
      { mode, direction: 'asc' as const },
      { mode, direction: 'desc' as const },
    ]),
  ]
}

export const CollectionSettingsPane: React.FC = () => {
  const {
    currentProjectSettings,
    updateCollectionSettings,
    projectPath,
    projectName,
    globalSettings,
  } = usePreferences()

  // Get collections from TanStack Query
  const { data: collections = [] } = useCollectionsQuery(
    projectPath,
    currentProjectSettings
  )

  // Track which collections are expanded
  const [expandedCollections, setExpandedCollections] = useState<Set<string>>(
    new Set()
  )

  // Ids that tie each label to its control. Inputs use htmlFor; select
  // triggers are buttons, which htmlFor would click, so they name themselves
  // with aria-labelledby
  const id = React.useId()

  const toggleCollection = (collectionName: string) => {
    const newExpanded = new Set(expandedCollections)
    if (newExpanded.has(collectionName)) {
      newExpanded.delete(collectionName)
    } else {
      newExpanded.add(collectionName)
    }
    setExpandedCollections(newExpanded)
  }

  // Get all schema fields from all collections
  const collectionFields = useMemo(() => {
    const fieldsMap = new Map<string, SchemaField[]>()

    collections.forEach(collection => {
      if (collection.complete_schema) {
        try {
          const schema = deserializeCompleteSchema(collection.complete_schema)
          if (schema) {
            fieldsMap.set(collection.name, schema.fields)
          }
        } catch (error) {
          void logWarn(
            `Failed to parse schema for ${collection.name}: ${String(error)}`
          )
        }
      }
    })

    return fieldsMap
  }, [collections])

  // Get collection-specific override (not inherited)
  const getCollectionOverride = (
    collectionName: string
  ): CollectionSettings | undefined => {
    return currentProjectSettings?.collections?.find(
      c => c.name === collectionName
    )
  }

  // Update a collection's path override
  const handlePathOverrideChange = (
    collectionName: string,
    key: 'contentDirectory' | 'assetsDirectory',
    value: string
  ) => {
    const problem =
      value.trim() &&
      checkCollectionFolder(
        value,
        key === 'contentDirectory'
          ? getEffectiveContentDirectory(currentProjectSettings)
          : null
      )
    if (problem) {
      // Enter and leaving the box both commit, so one toast for both
      toast.error("That folder can't be used", {
        id: 'collection-folder-refused',
        description: problem,
      })
      return
    }
    const existing = getCollectionOverride(collectionName)
    const newSettings: CollectionSettings = {
      name: collectionName,
      settings: {
        ...existing?.settings,
        pathOverrides: {
          ...existing?.settings?.pathOverrides,
          [key]: value || undefined, // Remove empty strings
        },
      },
    }

    void updateCollectionSettings(collectionName, newSettings.settings)
  }

  // Update a collection's frontmatter mapping
  const handleFrontmatterMappingChange = (
    collectionName: string,
    key: 'publishedDate' | 'title' | 'description' | 'draft',
    value: string
  ) => {
    const existing = getCollectionOverride(collectionName)
    const newSettings: CollectionSettings = {
      name: collectionName,
      settings: {
        ...existing?.settings,
        frontmatterMappings: {
          ...existing?.settings?.frontmatterMappings,
          [key]: value || undefined, // Remove empty strings
        },
      },
    }

    void updateCollectionSettings(collectionName, newSettings.settings)
  }

  // Reset all overrides for a collection
  const handleResetCollection = (collectionName: string) => {
    void updateCollectionSettings(collectionName, {})
  }

  // Save the file list order, as the sidebar's sort menu does
  const handleSortChange = (collectionName: string, sort: CollectionSort) => {
    const { currentProjectSettings: current, updateProjectSettings } =
      useProjectStore.getState()
    void updateProjectSettings({
      collections: withCollectionSort(current, collectionName, sort),
    })
  }

  // Update a collection's default file type
  const handleDefaultFileTypeChange = (
    collectionName: string,
    value: 'md' | 'mdx' | undefined
  ) => {
    const existing = getCollectionOverride(collectionName)
    const newSettings: CollectionSettings = {
      name: collectionName,
      settings: {
        ...existing?.settings,
        defaultFileType: value,
      },
    }
    void updateCollectionSettings(collectionName, newSettings.settings)
  }

  // Update a collection's body text setting
  const handleBodyTextChange = (
    collectionName: string,
    value: 'show' | 'hide' | undefined
  ) => {
    const existing = getCollectionOverride(collectionName)
    void updateCollectionSettings(collectionName, {
      ...existing?.settings,
      bodyText: value,
    })
  }

  // Update a collection's URL pattern
  const handleUrlPatternChange = (collectionName: string, value: string) => {
    const existing = getCollectionOverride(collectionName)
    const newSettings: CollectionSettings = {
      name: collectionName,
      settings: {
        ...existing?.settings,
        urlPattern: value || undefined, // Remove empty strings
      },
    }
    void updateCollectionSettings(collectionName, newSettings.settings)
  }

  // Update a collection's absolute paths setting
  const handleAbsolutePathsChange = (
    collectionName: string,
    checked: boolean
  ) => {
    const existing = getCollectionOverride(collectionName)
    const newSettings: CollectionSettings = {
      name: collectionName,
      settings: {
        ...existing?.settings,
        useAbsoluteAssetPaths: checked,
      },
    }
    void updateCollectionSettings(collectionName, newSettings.settings)
  }

  // Filter fields by type for a specific collection
  const getFieldsByType = (
    collectionName: string,
    fieldType: FieldType
  ): SchemaField[] => {
    const fields = collectionFields.get(collectionName) || []
    return fields.filter(field => field.type === fieldType)
  }

  // Render a field select dropdown
  const renderFieldSelect = (
    collectionName: string,
    value: string | string[] | undefined,
    onChange: (value: string) => void,
    fieldType: FieldType,
    placeholder: string,
    inheritedValue: string | null,
    labelId: string
  ) => {
    const fields = getFieldsByType(collectionName, fieldType)
    const currentValue = value || 'inherited'
    const displayValue =
      typeof currentValue === 'string' ? currentValue : 'inherited'

    const items = [
      {
        value: 'inherited',
        label: (
          <span className="text-muted-foreground">
            Automatic: {inheritedValue ?? 'none found'}
          </span>
        ),
      },
      ...fields.map(field => ({
        value: field.name,
        label: (
          <>
            {field.name}
            {!field.required && (
              <span className="ml-1 text-muted-foreground">(optional)</span>
            )}
          </>
        ),
      })),
    ]

    return (
      <Select
        items={items}
        value={displayValue}
        onValueChange={val => {
          if (val) onChange(val === 'inherited' ? '' : val)
        }}
      >
        <SelectTrigger aria-labelledby={labelId}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {items.map(item => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }

  if (collections.length === 0) {
    return (
      <div className="space-y-6">
        <div className="mb-6 rounded-lg border bg-muted/50 p-4">
          <h2 className="mb-1 text-base font-semibold text-heading">
            Collection Settings
            {projectName && (
              <span className="ml-2 font-normal text-muted-foreground">
                · {projectName}
              </span>
            )}
          </h2>
          <p className="text-sm text-muted-foreground">
            Configure collection-specific overrides for frontmatter mappings and
            paths. These settings override project-level defaults.
          </p>
        </div>

        <div className="rounded-lg border p-4 text-sm text-muted-foreground">
          No collections found. Collection settings will appear when a project
          with collections is loaded.
        </div>
      </div>
    )
  }

  const bodyTextItems = [
    {
      value: 'detect',
      label: (
        <span className="text-muted-foreground">
          Detect: hide the big text area when no entry uses it
        </span>
      ),
    },
    { value: 'show', label: 'Entries use the big text area' },
    {
      value: 'hide',
      label: "This collection doesn't use the big text area",
    },
  ]

  const fileTypeItems = (automatic: string | null) => [
    {
      value: 'inherited',
      label: (
        <span className="text-muted-foreground">Automatic: {automatic}</span>
      ),
    },
    { value: 'md', label: 'Markdown (.md)' },
    { value: 'mdx', label: 'MDX (.mdx)' },
  ]

  return (
    <div className="space-y-6">
      <div className="mb-6 rounded-lg border bg-muted/50 p-4">
        <h2 className="mb-1 text-base font-semibold text-heading">
          Collection Settings
          {projectName && (
            <span className="ml-2 font-normal text-muted-foreground">
              · {projectName}
            </span>
          )}
        </h2>
        <p className="text-sm text-muted-foreground">
          Each setting is worked out automatically from your project unless you
          set it here. <strong>Automatic</strong> ones say what they use and
          why; <strong>Set</strong> ones can be cleared to go back.{' '}
          <DocsLink href={DOCS_URLS.overrides}>Learn more</DocsLink>
        </p>
      </div>

      <div className="space-y-4">
        {collections.map(collection => {
          const isExpanded = expandedCollections.has(collection.name)
          const collectionOverride = getCollectionOverride(collection.name)
          const hasOverrides =
            !!collectionOverride &&
            hasCollectionSettings(collectionOverride.settings)

          if (!currentProjectSettings) return null

          const fieldId = (key: string) => `${id}-${collection.name}-${key}`

          // What each setting uses, and what it would use if cleared
          const explainInput = {
            collection,
            projectPath: projectPath ?? '',
            globalSettings,
            fields: collectionFields.get(collection.name) ?? null,
          }
          const explained = explainCollectionSettings({
            ...explainInput,
            projectSettings: currentProjectSettings,
          })
          const automatic = explainCollectionSettings({
            ...explainInput,
            projectSettings: currentProjectSettings && {
              ...currentProjectSettings,
              collections: currentProjectSettings.collections?.filter(
                c => c.name !== collection.name
              ),
            },
          })
          const fileTypes = fileTypeItems(automatic.fileType.value)
          const sortItems = sortChoices(
            collectionFields.get(collection.name) ?? []
          ).map(sort => ({
            value: `${sort.mode}:${sort.direction}`,
            label:
              sort.mode === 'default' ? (
                <span className="text-muted-foreground">
                  Automatic: {automatic.sort.value}
                </span>
              ) : (
                describeSort(sort)
              ),
          }))
          const ownSort = collectionOverride?.settings?.sort

          return (
            <Collapsible
              key={collection.name}
              open={isExpanded}
              onOpenChange={() => toggleCollection(collection.name)}
            >
              <div className="rounded-lg border bg-card">
                <CollapsibleTrigger className="flex w-full items-center justify-between p-4 transition-colors hover:bg-accent/50">
                  <div className="flex items-center gap-2">
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-icon" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-icon" />
                    )}
                    <span className="font-medium text-heading">
                      {collectionDisplayName(collection.name)}
                    </span>
                    {hasOverrides && (
                      <span className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">
                        Custom
                      </span>
                    )}
                  </div>
                </CollapsibleTrigger>

                <CollapsibleContent>
                  <div className="space-y-6 p-4 pt-0">
                    {/* Path Overrides Section */}
                    <SettingsSection title="Path Overrides">
                      <Field>
                        <FieldLabel htmlFor={fieldId('content')}>
                          Content Directory
                        </FieldLabel>
                        <FieldContent>
                          <PreferencesTextInput
                            id={fieldId('content')}
                            value={
                              collectionOverride?.settings?.pathOverrides
                                ?.contentDirectory || ''
                            }
                            onCommit={value =>
                              handlePathOverrideChange(
                                collection.name,
                                'contentDirectory',
                                value
                              )
                            }
                            placeholder={automatic.contentFolder.value ?? ''}
                          />
                          <SettingStatus
                            explanation={explained.contentFolder}
                            onClear={() =>
                              handlePathOverrideChange(
                                collection.name,
                                'contentDirectory',
                                ''
                              )
                            }
                          />
                          <FieldDescription>
                            The folder that holds this collection&apos;s
                            entries, from the project folder. Leave it empty to
                            find it automatically.
                          </FieldDescription>
                        </FieldContent>
                      </Field>

                      <Field>
                        <FieldLabel htmlFor={fieldId('assets')}>
                          Assets Directory
                        </FieldLabel>
                        <FieldContent>
                          <PreferencesTextInput
                            id={fieldId('assets')}
                            value={
                              collectionOverride?.settings?.pathOverrides
                                ?.assetsDirectory || ''
                            }
                            onCommit={value =>
                              handlePathOverrideChange(
                                collection.name,
                                'assetsDirectory',
                                value
                              )
                            }
                            placeholder={automatic.assetsFolder.value ?? ''}
                          />
                          <SettingStatus
                            explanation={explained.assetsFolder}
                            onClear={() =>
                              handlePathOverrideChange(
                                collection.name,
                                'assetsDirectory',
                                ''
                              )
                            }
                          />
                          <FieldDescription>
                            Images added to this collection&apos;s entries are
                            copied into a folder named after the collection in
                            here.
                          </FieldDescription>
                        </FieldContent>
                      </Field>

                      <Field>
                        <div className="flex items-center justify-between">
                          <div className="flex-1">
                            <FieldLabel htmlFor={fieldId('absolute-paths')}>
                              Use Absolute Paths for Images
                            </FieldLabel>
                            <FieldDescription>
                              Override to use absolute paths from project root
                              (e.g.,{' '}
                              <code className="text-xs">
                                /src/assets/image.png
                              </code>
                              ) instead of the default relative paths (e.g.,{' '}
                              <code className="text-xs">
                                ../../assets/image.png
                              </code>
                              ).
                            </FieldDescription>
                          </div>
                          <Switch
                            id={fieldId('absolute-paths')}
                            checked={
                              collectionOverride?.settings
                                ?.useAbsoluteAssetPaths ?? false
                            }
                            onCheckedChange={checked =>
                              handleAbsolutePathsChange(
                                collection.name,
                                checked
                              )
                            }
                          />
                        </div>
                      </Field>
                    </SettingsSection>

                    {/* File Defaults Section */}
                    <SettingsSection title="File Defaults">
                      <Field>
                        <FieldLabel id={fieldId('file-type')}>
                          Default File Type for New Files
                        </FieldLabel>
                        <FieldContent>
                          <Select
                            items={fileTypes}
                            value={
                              collectionOverride?.settings?.defaultFileType ||
                              'inherited'
                            }
                            onValueChange={value => {
                              if (!value) return
                              handleDefaultFileTypeChange(
                                collection.name,
                                value === 'inherited'
                                  ? undefined
                                  : (value as 'md' | 'mdx')
                              )
                            }}
                          >
                            <SelectTrigger
                              aria-labelledby={fieldId('file-type')}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {fileTypes.map(item => (
                                <SelectItem key={item.value} value={item.value}>
                                  {item.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <SettingStatus
                            explanation={explained.fileType}
                            code={false}
                            onClear={() =>
                              handleDefaultFileTypeChange(
                                collection.name,
                                undefined
                              )
                            }
                          />
                          <FieldDescription>
                            File type used when creating new files in this
                            collection
                          </FieldDescription>
                        </FieldContent>
                      </Field>

                      <Field>
                        <FieldLabel id={fieldId('sort')}>
                          File List Order
                        </FieldLabel>
                        <FieldContent>
                          <Select
                            items={sortItems}
                            value={
                              ownSort
                                ? `${ownSort.mode}:${ownSort.direction}`
                                : 'default:desc'
                            }
                            onValueChange={value => {
                              if (!value) return
                              const [mode, direction] = value.split(':')
                              handleSortChange(collection.name, {
                                mode: mode!,
                                direction: direction === 'asc' ? 'asc' : 'desc',
                              })
                            }}
                          >
                            <SelectTrigger aria-labelledby={fieldId('sort')}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {sortItems.map(item => (
                                <SelectItem key={item.value} value={item.value}>
                                  {item.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <SettingStatus
                            explanation={explained.sort}
                            code={false}
                            onClear={() =>
                              handleSortChange(collection.name, {
                                mode: 'default',
                                direction: 'desc',
                              })
                            }
                          />
                          <FieldDescription>
                            How the file list is sorted when this collection
                            opens. Changing the sort in the file list changes
                            this too
                          </FieldDescription>
                        </FieldContent>
                      </Field>

                      <Field>
                        <FieldLabel id={fieldId('body-text')}>
                          Body Text
                        </FieldLabel>
                        <FieldContent>
                          <Select
                            items={bodyTextItems}
                            value={
                              collectionOverride?.settings?.bodyText || 'detect'
                            }
                            onValueChange={value => {
                              if (!value) return
                              handleBodyTextChange(
                                collection.name,
                                value === 'detect'
                                  ? undefined
                                  : (value as 'show' | 'hide')
                              )
                            }}
                          >
                            <SelectTrigger
                              aria-labelledby={fieldId('body-text')}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {bodyTextItems.map(item => (
                                <SelectItem key={item.value} value={item.value}>
                                  {item.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FieldDescription>
                            Collections that are only fields, like settings or
                            testimonials, don&apos;t need the big text area. An
                            entry that already has text in it always shows it
                          </FieldDescription>
                        </FieldContent>
                      </Field>
                    </SettingsSection>

                    {/* Frontmatter Mappings Section */}
                    <SettingsSection title="Frontmatter Mappings">
                      <Field>
                        <FieldLabel id={fieldId('date-field')}>
                          Published Date Field
                        </FieldLabel>
                        <FieldContent>
                          {renderFieldSelect(
                            collection.name,
                            collectionOverride?.settings?.frontmatterMappings
                              ?.publishedDate,
                            value =>
                              handleFrontmatterMappingChange(
                                collection.name,
                                'publishedDate',
                                value
                              ),
                            FieldType.Date,
                            'Select date field',
                            automatic.publishedDate.value,
                            fieldId('date-field')
                          )}
                          <SettingStatus
                            explanation={explained.publishedDate}
                            onClear={() =>
                              handleFrontmatterMappingChange(
                                collection.name,
                                'publishedDate',
                                ''
                              )
                            }
                          />
                          <FieldDescription>
                            Field used for ordering files in the list
                          </FieldDescription>
                        </FieldContent>
                      </Field>

                      <Field>
                        <FieldLabel id={fieldId('title-field')}>
                          Title Field
                        </FieldLabel>
                        <FieldContent>
                          {renderFieldSelect(
                            collection.name,
                            collectionOverride?.settings?.frontmatterMappings
                              ?.title,
                            value =>
                              handleFrontmatterMappingChange(
                                collection.name,
                                'title',
                                value
                              ),
                            FieldType.String,
                            'Select text field',
                            automatic.title.value,
                            fieldId('title-field')
                          )}
                          <SettingStatus
                            explanation={explained.title}
                            onClear={() =>
                              handleFrontmatterMappingChange(
                                collection.name,
                                'title',
                                ''
                              )
                            }
                          />
                          <FieldDescription>
                            Field that gets special treatment in the frontmatter
                            panel
                          </FieldDescription>
                        </FieldContent>
                      </Field>

                      <Field>
                        <FieldLabel id={fieldId('description-field')}>
                          Description Field
                        </FieldLabel>
                        <FieldContent>
                          {renderFieldSelect(
                            collection.name,
                            collectionOverride?.settings?.frontmatterMappings
                              ?.description,
                            value =>
                              handleFrontmatterMappingChange(
                                collection.name,
                                'description',
                                value
                              ),
                            FieldType.String,
                            'Select text field',
                            automatic.description.value,
                            fieldId('description-field')
                          )}
                          <SettingStatus
                            explanation={explained.description}
                            onClear={() =>
                              handleFrontmatterMappingChange(
                                collection.name,
                                'description',
                                ''
                              )
                            }
                          />
                          <FieldDescription>
                            Field that gets special treatment in the frontmatter
                            panel
                          </FieldDescription>
                        </FieldContent>
                      </Field>

                      <Field>
                        <FieldLabel id={fieldId('draft-field')}>
                          Draft Field
                        </FieldLabel>
                        <FieldContent>
                          {renderFieldSelect(
                            collection.name,
                            collectionOverride?.settings?.frontmatterMappings
                              ?.draft,
                            value =>
                              handleFrontmatterMappingChange(
                                collection.name,
                                'draft',
                                value
                              ),
                            FieldType.Boolean,
                            'Select boolean field',
                            automatic.draft.value,
                            fieldId('draft-field')
                          )}
                          <SettingStatus
                            explanation={explained.draft}
                            onClear={() =>
                              handleFrontmatterMappingChange(
                                collection.name,
                                'draft',
                                ''
                              )
                            }
                          />
                          <FieldDescription>
                            Field that shows a draft marker in the file list
                          </FieldDescription>
                        </FieldContent>
                      </Field>
                    </SettingsSection>

                    {/* Link URL Pattern Section */}
                    <SettingsSection title="Content Links">
                      <Field>
                        <FieldLabel htmlFor={fieldId('url-pattern')}>
                          Link URL Pattern
                        </FieldLabel>
                        <FieldContent>
                          <PreferencesTextInput
                            id={fieldId('url-pattern')}
                            value={
                              collectionOverride?.settings?.urlPattern || ''
                            }
                            onCommit={value =>
                              handleUrlPatternChange(collection.name, value)
                            }
                            placeholder="/path/{slug}"
                          />
                          <FieldDescription>
                            URL template for content links. Use{' '}
                            <code className="text-xs">{'{slug}'}</code> for the
                            content slug. Leave empty for relative file paths.
                          </FieldDescription>
                        </FieldContent>
                      </Field>
                    </SettingsSection>

                    {/* Reset Button */}
                    {hasOverrides && (
                      <div className="border-t pt-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleResetCollection(collection.name)}
                        >
                          Reset to Defaults
                        </Button>
                      </div>
                    )}
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>
          )
        })}
      </div>
    </div>
  )
}
