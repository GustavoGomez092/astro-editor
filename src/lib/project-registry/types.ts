/**
 * Project Registry Types
 *
 * Simple type definitions for project identification and persistence
 */

import type { GrammarDialect } from '../bindings'

/**
 * Utility type for deep partial - makes all nested properties optional
 * Used for settings updates where only changed fields need to be passed
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P]
}

export interface ProjectMetadata {
  id: string // Generated project ID (package.json name + path hash if needed)
  name: string // From package.json
  path: string // Current full path
  lastOpened: string // ISO timestamp
  created: string // ISO timestamp
}

export interface ProjectSettings {
  // Project-specific overrides for paths
  pathOverrides: {
    contentDirectory?: string
    assetsDirectory?: string
    mdxComponentsDirectory?: string
  }
  // Project-specific overrides for frontmatter field mappings
  frontmatterMappings: {
    publishedDate?: string
    title?: string
    description?: string
    draft?: string
  }
  // Default file type for new files
  defaultFileType?: 'md' | 'mdx'
  // Override to use absolute paths for images (defaults to relative paths, matching Astro conventions)
  useAbsoluteAssetPaths?: boolean
  // Experimental: the component builder adds the import a component needs to an MDX file. Off unless set.
  addComponentImports?: boolean
  // Runs the dev server instead of the `dev` script (Rust reads it from the
  // project file, see src-tauri/src/dev_server/detect.rs). null or absent: none
  devCommand?: string | null
  // Collection-specific settings overrides
  collections?: CollectionSettings[]
}

// Collection-specific settings (subset of ProjectSettings)
export interface CollectionSpecificSettings {
  pathOverrides?: {
    contentDirectory?: string
    assetsDirectory?: string
  }
  frontmatterMappings?: {
    publishedDate?: string | string[]
    title?: string
    description?: string
    draft?: string
  }
  // Default file type for new files in this collection
  defaultFileType?: 'md' | 'mdx'
  // Override to use absolute paths for images (collection-level override)
  useAbsoluteAssetPaths?: boolean
  // URL pattern template for content links (e.g. "/writing/{slug}")
  urlPattern?: string
  // Whether entries have body text below the frontmatter. Unset, it's detected:
  // the body editor is hidden when no entry has any (see lib/files/body-text.ts)
  bodyText?: 'show' | 'hide'
  // How the sidebar sorts the collection's files, as last chosen. Left out for
  // the Default sort
  sort?: CollectionSort
}

export interface CollectionSort {
  mode: string // 'title' | 'filename' | 'date-{field}' | 'order' | 'modified'
  direction: 'asc' | 'desc'
}

export interface CollectionSettings {
  name: string // Collection identifier
  settings: CollectionSpecificSettings
}

export interface ProjectData {
  settings: ProjectSettings
  collections?: CollectionSettings[] // Collection-specific overrides
  version: number
}

export interface ProjectRegistry {
  projects: Record<string, ProjectMetadata> // projectId -> metadata
  lastOpenedProject: string | null
  version: number
}

export interface GlobalSettings {
  general: {
    ideCommand: string
    theme: 'light' | 'dark' | 'system'
    highlights: {
      nouns: boolean
      verbs: boolean
      adjectives: boolean
      adverbs: boolean
      conjunctions: boolean
    }
    autoSaveDelay: number
    defaultFileType: 'md' | 'mdx'
    // The Git panel, Publish and Preview. Default: PUBLISHING_TOOLS_DEFAULT
    showPublishingTools: boolean
  }
  appearance: {
    headingColor: {
      light: string
      dark: string
    }
    editorBaseFontSize?: number // 1-30, default 18
  }
  // Spelling and grammar checking. Unset fields resolve in lib/grammar/settings.ts
  grammar?: GrammarSettings
  advanced?: {
    // OAuth app client ID for GitHub sign-in, for builds compiled without one.
    // Read by Rust (github::auth::resolve_client_id); null uses the built-in ID
    githubClientId?: string | null
  }
  version: number
}

export interface GrammarSettings {
  enabled?: boolean // Default: on
  dialect?: GrammarDialect // Default: american
  dictionary?: string[] // Words never flagged as misspelt
}
