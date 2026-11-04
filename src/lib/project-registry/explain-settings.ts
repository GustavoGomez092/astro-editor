/**
 * What each of a collection's settings is, and why: set by the writer for
 * this collection, or worked out (inferred) from the project, the schema,
 * the content config or Astro's conventions. Collection Settings shows this
 * next to each setting
 */

import { FieldType, type SchemaField } from '../schema'
import { ASTRO_PATHS } from '../constants'
import { DEFAULT_PUBLISHED_DATE_FIELDS } from './defaults'
import type { CollectionSort, GlobalSettings, ProjectSettings } from './types'

export interface SettingExplanation {
  state: 'set' | 'inferred'
  /** What's used: a folder, a field name or a description. Null: nothing */
  value: string | null
  /** Why, as a phrase: "found in the schema" */
  reason: string
  /** What won't work as things are */
  warning?: string
}

export interface CollectionSettingsExplained {
  contentFolder: SettingExplanation
  assetsFolder: SettingExplanation
  title: SettingExplanation
  description: SettingExplanation
  draft: SettingExplanation
  publishedDate: SettingExplanation
  sort: SettingExplanation
  fileType: SettingExplanation
}

export interface ExplainInput {
  collection: { name: string; path: string; loader_base?: string | null }
  projectPath: string
  projectSettings: ProjectSettings | null | undefined
  globalSettings: GlobalSettings | null | undefined
  /** The collection's schema fields, or null when it has no schema */
  fields: SchemaField[] | null
}

const SET = 'set for this collection'

/** `./src/assets/` → `src/assets` */
function tidyFolder(folder: string): string {
  return folder.trim().replace(/^\.\//, '').replace(/\/+$/, '')
}

function relativeTo(projectPath: string, path: string): string {
  const root = projectPath.replace(/\/+$/, '')
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

const FIELD_KINDS = {
  title: { type: FieldType.String, kind: 'text' },
  description: { type: FieldType.String, kind: 'text' },
  draft: { type: FieldType.Boolean, kind: 'yes/no' },
} as const

const MISSING_FIELD_WARNINGS = {
  title: 'The file list shows file names instead of titles.',
  description: 'No field is treated as the description.',
  draft: 'Nothing will be marked as a draft.',
} as const

const FILE_TYPE_LABELS = { md: 'Markdown (.md)', mdx: 'MDX (.mdx)' } as const

export function explainCollectionSettings(
  input: ExplainInput
): CollectionSettingsExplained {
  const { collection, projectSettings, globalSettings, fields } = input
  const own = projectSettings?.collections?.find(
    c => c.name === collection.name
  )?.settings
  const publishedDate = explainPublishedDate(input, own?.frontmatterMappings)

  return {
    contentFolder: explainContentFolder(input, own?.pathOverrides),
    assetsFolder: explainAssetsFolder(projectSettings, own?.pathOverrides),
    title: explainField('title', own?.frontmatterMappings?.title, input),
    description: explainField(
      'description',
      own?.frontmatterMappings?.description,
      input
    ),
    draft: explainField('draft', own?.frontmatterMappings?.draft, input),
    publishedDate,
    sort: explainSort(own?.sort ?? null, publishedDate, fields),
    fileType: explainFileType(
      own?.defaultFileType,
      projectSettings,
      globalSettings
    ),
  }
}

function explainContentFolder(
  { collection, projectPath }: ExplainInput,
  paths: { contentDirectory?: string } | undefined
): SettingExplanation {
  if (paths?.contentDirectory) {
    return {
      state: 'set',
      value: tidyFolder(paths.contentDirectory),
      reason: SET,
    }
  }
  if (collection.loader_base) {
    return {
      state: 'inferred',
      value: tidyFolder(collection.loader_base),
      reason: 'from the glob loader',
    }
  }
  return {
    state: 'inferred',
    value: relativeTo(projectPath, collection.path),
    reason: "the content folder and the collection's name",
  }
}

function explainAssetsFolder(
  projectSettings: ProjectSettings | null | undefined,
  paths: { assetsDirectory?: string } | undefined
): SettingExplanation {
  if (paths?.assetsDirectory) {
    return {
      state: 'set',
      value: tidyFolder(paths.assetsDirectory),
      reason: SET,
    }
  }
  const project = projectSettings?.pathOverrides?.assetsDirectory
  const usual = tidyFolder(ASTRO_PATHS.ASSETS_DIR)
  if (project && tidyFolder(project) !== usual) {
    return {
      state: 'inferred',
      value: tidyFolder(project),
      reason: "the project's setting",
    }
  }
  return { state: 'inferred', value: usual, reason: "Astro's usual folder" }
}

function explainField(
  key: keyof typeof FIELD_KINDS,
  own: string | undefined,
  { projectSettings, fields }: ExplainInput
): SettingExplanation {
  const { type, kind } = FIELD_KINDS[key]
  const found = (name: string) => fields?.find(f => f.name === name)

  if (own) {
    const field = found(own)
    if (!fields || (field && field.type === type)) {
      return { state: 'set', value: own, reason: SET }
    }
    return {
      state: 'set',
      value: own,
      reason: SET,
      warning: field
        ? `\`${own}\` in this collection's schema isn't a ${kind} field.`
        : `This collection's schema has no \`${own}\` field.`,
    }
  }

  // The project's mapping, which new projects are seeded with, or the usual name
  const project = projectSettings?.frontmatterMappings?.[key]
  const name = project || key
  const fromProject = !!project && project !== key
  if (!fields) {
    return {
      state: 'inferred',
      value: name,
      reason: fromProject
        ? "the project's setting, as this collection has no schema"
        : 'the usual name, as this collection has no schema',
    }
  }
  const field = found(name)
  if (field && field.type === type) {
    return {
      state: 'inferred',
      value: name,
      reason: fromProject
        ? "the project's setting, found in the schema"
        : 'found in the schema',
    }
  }
  return {
    state: 'inferred',
    value: null,
    reason: field
      ? `\`${name}\` in the schema isn't a ${kind} field`
      : `no \`${name}\` field in the schema`,
    warning: MISSING_FIELD_WARNINGS[key],
  }
}

function explainPublishedDate(
  { projectSettings, fields }: ExplainInput,
  own: { publishedDate?: string | string[] } | undefined
): SettingExplanation {
  const asList = (value: string | string[]) =>
    Array.isArray(value) ? value : [value]

  if (own?.publishedDate && asList(own.publishedDate).length > 0) {
    return {
      state: 'set',
      value: asList(own.publishedDate).join(', '),
      reason: SET,
    }
  }

  // Files are dated by the mapped field, then the usual ones (getPublishedDate)
  const project = projectSettings?.frontmatterMappings?.publishedDate
  const candidates = [
    ...new Set([
      ...(project ? asList(project) : []),
      ...DEFAULT_PUBLISHED_DATE_FIELDS,
    ]),
  ]
  if (!fields) {
    return {
      state: 'inferred',
      value: candidates.join(', '),
      reason: 'the first of these a file has, as this collection has no schema',
    }
  }
  const dates = new Set(
    fields.filter(f => f.type === FieldType.Date).map(f => f.name)
  )
  const match = candidates.find(name => dates.has(name))
  if (match) {
    return {
      state: 'inferred',
      value: match,
      reason:
        project &&
        asList(project).includes(match) &&
        !DEFAULT_PUBLISHED_DATE_FIELDS.includes(match)
          ? "the project's setting, found in the schema"
          : 'found in the schema',
    }
  }
  return {
    state: 'inferred',
    value: null,
    reason: `no ${listWords(candidates)} field in the schema`,
    warning: 'Files are listed by title instead of by date.',
  }
}

function explainSort(
  sort: CollectionSort | null,
  publishedDate: SettingExplanation,
  fields: SchemaField[] | null
): SettingExplanation {
  if (sort) {
    return {
      state: 'set',
      value: describeSort(sort),
      reason: 'set here or in the file list',
    }
  }
  if (publishedDate.value && fields) {
    return {
      state: 'inferred',
      value: 'Newest first',
      reason: `by \`${publishedDate.value}\`, with files that have no date at the top`,
    }
  }
  if (!fields) {
    return {
      state: 'inferred',
      value: 'Newest first',
      reason: 'by date, with files that have no date at the top',
    }
  }
  return {
    state: 'inferred',
    value: 'By title',
    reason: 'no date field was found',
  }
}

/** "Title, A to Z", "pubDate, newest first" */
export function describeSort({ mode, direction }: CollectionSort): string {
  const up = direction === 'asc'
  switch (mode) {
    case 'title':
      return `Title, ${up ? 'A to Z' : 'Z to A'}`
    case 'filename':
      return `File name, ${up ? 'A to Z' : 'Z to A'}`
    case 'order':
      return `Order, ${up ? 'lowest first' : 'highest first'}`
    case 'modified':
      return `Last changed, ${up ? 'oldest first' : 'newest first'}`
    default: {
      const field = mode.startsWith('date-') ? mode.slice(5) : mode
      return `${field}, ${up ? 'oldest first' : 'newest first'}`
    }
  }
}

function explainFileType(
  own: 'md' | 'mdx' | undefined,
  projectSettings: ProjectSettings | null | undefined,
  globalSettings: GlobalSettings | null | undefined
): SettingExplanation {
  if (own) return { state: 'set', value: FILE_TYPE_LABELS[own], reason: SET }
  if (projectSettings?.defaultFileType) {
    return {
      state: 'inferred',
      value: FILE_TYPE_LABELS[projectSettings.defaultFileType],
      reason: "the project's setting",
    }
  }
  if (globalSettings?.general?.defaultFileType) {
    return {
      state: 'inferred',
      value: FILE_TYPE_LABELS[globalSettings.general.defaultFileType],
      reason: 'the app setting',
    }
  }
  return {
    state: 'inferred',
    value: FILE_TYPE_LABELS.md,
    reason: 'the usual type',
  }
}

/** "pubDate, date or publishedDate" */
function listWords(words: string[]): string {
  return words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`
}
