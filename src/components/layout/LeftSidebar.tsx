import React, { useCallback, useMemo } from 'react'
import { error as logError } from '@tauri-apps/plugin-log'
import { useShallow } from 'zustand/react/shallow'
import { useQueryClient } from '@tanstack/react-query'
import { useEditorStore } from '../../store/editorStore'
import { useProjectStore } from '../../store/projectStore'
import { useUIStore } from '../../store/uiStore'
import { useCollectionsQuery } from '../../hooks/queries/useCollectionsQuery'
import { useDirectoryScanQuery } from '../../hooks/queries/useDirectoryScanQuery'
import { useCollectionFileCountsQuery } from '../../hooks/queries/useCollectionFileCountsQuery'
import { fetchCollectionFiles } from '../../hooks/queries/useCollectionFilesQuery'
import { queryKeys } from '../../lib/query-keys'
import { openOnlyEntry } from '../../lib/files/only-entry'
import type { FileEntry, Collection } from '@/types'
import { useRenameFileMutation } from '../../hooks/mutations/useRenameFileMutation'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import {
  FolderOpen,
  ArrowLeft,
  FileText,
  Filter,
  Folder,
  ChevronRight,
  AlertTriangle,
  SlidersHorizontal,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { FileContextMenu } from '../ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { useEffectiveSettings } from '../../hooks/settings/useEffectiveSettings'
import { FileItem } from './FileItem'
import { FilterBar } from './FilterBar'
import { openProjectViaDialog } from '../../lib/projects/actions'
import { filterFilesByDraft } from '../../lib/files/filtering'
import {
  sortFiles,
  getSortOptionsForCollection,
  defaultSortDirection,
} from '../../lib/files/sorting'
import {
  getCollectionSort,
  withCollectionSort,
} from '../../lib/project-registry/collection-settings'
import type { CollectionSort } from '../../lib/project-registry/types'
import { filterFilesBySearch } from '../../lib/files/search'
import { deserializeCompleteSchema } from '../../lib/schema'
import { collectionDisplayName } from '../../lib/collection-name'

/** Saves the selected collection's sort in the project settings. */
function saveCollectionSort(
  change: (current: CollectionSort) => CollectionSort
) {
  const { selectedCollection, currentProjectSettings, updateProjectSettings } =
    useProjectStore.getState()
  if (!selectedCollection) return

  const current = getCollectionSort(currentProjectSettings, selectedCollection)
  void updateProjectSettings({
    collections: withCollectionSort(
      currentProjectSettings,
      selectedCollection,
      change(current)
    ),
  })
}
import { useShowPublishingTools } from '../../hooks/settings/useShowPublishingTools'
import { useGitStatusQuery } from '../../hooks/queries/useGitStatusQuery'
import { useGitStore, type GitPanelTab } from '../../store/gitStore'
import { ChangesPanel } from '../git/ChangesPanel'

/** The content files: collections, folders and entries. */
const FilesPanel: React.FC = () => {
  // Object subscription needs shallow
  const currentFile = useEditorStore(useShallow(state => state.currentFile))

  // Primitive subscriptions - selector syntax for consistency
  const selectedCollection = useProjectStore(state => state.selectedCollection)
  const currentSubdirectory = useProjectStore(
    state => state.currentSubdirectory
  )
  const projectPath = useProjectStore(state => state.projectPath)
  const currentProjectSettings = useProjectStore(
    useShallow(state => state.currentProjectSettings)
  )

  // Get draft filter state from UI store (ephemeral, per-collection)
  const showDraftsOnly =
    useUIStore(
      state => state.draftFilterByCollection[selectedCollection || '']
    ) || false

  // Get collection view state from UI store
  const collectionViewState = useUIStore(
    useShallow(state =>
      selectedCollection
        ? state.getCollectionViewState(selectedCollection)
        : { searchQuery: '', filterBarExpanded: false }
    )
  )

  // The sort is saved per collection in the project settings
  const collectionSort = useProjectStore(
    useShallow(state =>
      getCollectionSort(state.currentProjectSettings, selectedCollection || '')
    )
  )

  // Use getState() pattern for callbacks to avoid render cascades
  const handleToggleDraftsOnly = useCallback(() => {
    const { selectedCollection } = useProjectStore.getState()
    if (selectedCollection) {
      useUIStore.getState().toggleDraftFilter(selectedCollection)
    }
  }, [])

  const handleToggleFilterBar = useCallback(() => {
    const { selectedCollection } = useProjectStore.getState()
    if (selectedCollection) {
      useUIStore.getState().toggleFilterBar(selectedCollection)
    }
  }, [])

  const handleSearchChange = useCallback((query: string) => {
    const { selectedCollection } = useProjectStore.getState()
    if (selectedCollection) {
      useUIStore.getState().setSearchQuery(selectedCollection, query)
    }
  }, [])

  const handleClearSearch = useCallback(() => {
    const { selectedCollection } = useProjectStore.getState()
    if (selectedCollection) {
      useUIStore.getState().setSearchQuery(selectedCollection, '')
    }
  }, [])

  const handleSortModeChange = useCallback((mode: string) => {
    saveCollectionSort(() => ({ mode, direction: defaultSortDirection(mode) }))
  }, [])

  const handleSortDirectionToggle = useCallback(() => {
    saveCollectionSort(current => ({
      ...current,
      direction: current.direction === 'asc' ? 'desc' : 'asc',
    }))
  }, [])

  const { data: collections = [] } = useCollectionsQuery(
    projectPath,
    currentProjectSettings
  )

  const currentCollection = collections.find(c => c.name === selectedCollection)

  const {
    data: dirContents,
    refetch: refetchFiles,
    isLoading: isLoadingDirectory,
    isError: hasDirectoryError,
    error: directoryError,
  } = useDirectoryScanQuery(
    projectPath,
    selectedCollection,
    currentCollection?.path || null,
    currentSubdirectory
  )
  // Extract files and subdirectories in useMemo to avoid lint warnings
  const files = React.useMemo(() => dirContents?.files || [], [dirContents])
  const subdirectories = React.useMemo(
    () => dirContents?.subdirectories || [],
    [dirContents]
  )

  const renameMutation = useRenameFileMutation()

  // File counts for all collections (recursive)
  const fileCounts = useCollectionFileCountsQuery(projectPath, collections)

  // Get effective settings for frontmatter field mappings (collection-aware)
  const { frontmatterMappings } = useEffectiveSettings(
    selectedCollection || undefined
  )

  // State for rename functionality
  const [renamingFileId, setRenamingFileId] = React.useState<string | null>(
    null
  )

  const queryClient = useQueryClient()

  // A collection with exactly one entry opens it too; Back still returns to
  // the collections list
  const handleCollectionClick = (collection: Collection) => {
    useProjectStore.getState().setSelectedCollection(collection.name)
    const projectPath = useProjectStore.getState().projectPath ?? ''
    openOnlyEntry({
      collectionName: collection.name,
      count: fileCounts[collection.name],
      loadFiles: () =>
        queryClient.fetchQuery({
          queryKey: queryKeys.collectionFiles(projectPath, collection.name),
          queryFn: () => fetchCollectionFiles(collection.path, collection.name),
        }),
    }).catch((error: unknown) => {
      void logError(
        `Failed to open the only entry in ${collection.name}: ${String(error)}`
      )
    })
  }

  const handleBackClick = () => {
    useProjectStore.getState().navigateUp()
  }

  const handleSubdirectoryClick = (relativePath: string) => {
    useProjectStore.getState().setCurrentSubdirectory(relativePath)
  }

  const handleBreadcrumbClick = (subdirectory: string | null) => {
    useProjectStore.getState().setCurrentSubdirectory(subdirectory)
  }

  const handleFileClick = (file: FileEntry) => {
    useEditorStore.getState().openFile(file)
  }

  const handleContextMenu = async (
    event: React.MouseEvent,
    file: FileEntry
  ) => {
    event.preventDefault()
    event.stopPropagation()

    await FileContextMenu.show({
      file,
      position: { x: event.clientX, y: event.clientY },
      onRefresh: () => {
        void refetchFiles()
      },
      onRename: handleRename,
    })
  }

  const handleRename = (file: FileEntry) => {
    setRenamingFileId(file.id)
  }

  const handleRenameSubmit = (file: FileEntry, newName: string) => {
    const trimmedName = newName.trim()
    const originalFullName = file.extension
      ? `${file.name}.${file.extension}`
      : file.name
    if (!trimmedName || trimmedName === originalFullName) {
      setRenamingFileId(null)
      return
    }

    const directory = file.path.substring(0, file.path.lastIndexOf('/'))
    const newPath = `${directory}/${trimmedName}`
    const { projectPath, selectedCollection } = useProjectStore.getState()
    if (!projectPath || !selectedCollection) {
      setRenamingFileId(null)
      return
    }

    // mutateAsync rather than mutate's callbacks, which only run for the
    // latest call. On failure the name stays editable, so the writer can retry
    void renameMutation
      .mutateAsync({
        oldPath: file.path,
        oldFileId: file.id,
        newPath,
        projectPath,
        collectionName: selectedCollection,
      })
      .then(() => {
        // Update current file path if this is the current file
        const { currentFile, updateCurrentFileAfterRename } =
          useEditorStore.getState()
        if (currentFile?.path === file.path) {
          updateCurrentFileAfterRename(newPath)
        }
        // Another file may be being renamed by now
        setRenamingFileId(current => (current === file.id ? null : current))
      })
      .catch((error: unknown) => {
        void logError(`Failed to rename file: ${String(error)}`)
      })
  }

  const handleRenameCancel = () => {
    setRenamingFileId(null)
  }

  // Parse the schema for the current collection
  const completeSchemaJson = currentCollection?.complete_schema ?? null
  const currentSchema = useMemo(() => {
    if (!completeSchemaJson) return null
    return deserializeCompleteSchema(completeSchemaJson)
  }, [completeSchemaJson])

  // Get sort options based on schema
  const sortOptions = useMemo(() => {
    return getSortOptionsForCollection(currentSchema)
  }, [currentSchema])

  // Derived filter states for UI indicators
  const searchActive = collectionViewState.searchQuery.trim() !== ''
  const sortActive = collectionSort.mode !== 'default'

  // Determine header background class based on composable states
  // Priority: drafts (intentional filter) > search (hides files) > default
  const headerBgClass = useMemo(() => {
    if (showDraftsOnly) return 'bg-draft-bg'
    if (searchActive) return 'bg-filter-bg'
    return 'bg-muted/30'
  }, [showDraftsOnly, searchActive])

  // Filter and sort files
  const filteredAndSortedFiles = useMemo((): FileEntry[] => {
    // Step 1: Filter by draft status
    let result = filterFilesByDraft(files, showDraftsOnly, frontmatterMappings)

    // Step 2: Filter by search query
    if (collectionViewState.searchQuery) {
      result = filterFilesBySearch(
        result,
        collectionViewState.searchQuery,
        frontmatterMappings
      )
    }

    // Step 3: Sort files
    return sortFiles(
      result,
      {
        mode: collectionSort.mode,
        direction: collectionSort.direction,
      },
      frontmatterMappings
    )
  }, [
    files,
    frontmatterMappings,
    showDraftsOnly,
    collectionViewState.searchQuery,
    collectionSort.mode,
    collectionSort.direction,
  ])

  const headerTitle = selectedCollection
    ? collectionDisplayName(selectedCollection)
    : 'Content'

  // Generate breadcrumb segments
  const breadcrumbSegments = React.useMemo(() => {
    if (!selectedCollection || !currentSubdirectory) return []
    return currentSubdirectory.split('/')
  }, [selectedCollection, currentSubdirectory])

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className={cn('border-b p-3', headerBgClass)}>
        <div className="flex items-center gap-2">
          {selectedCollection && (
            <Button
              onClick={handleBackClick}
              variant="ghost"
              size="sm"
              className={cn(
                'size-7 p-0 flex-shrink-0',
                // Match header background color for hover state
                showDraftsOnly
                  ? 'text-draft hover:bg-draft-bg/50'
                  : searchActive
                    ? 'text-filter hover:bg-filter-bg/50'
                    : 'text-muted-foreground hover:bg-muted'
              )}
              title="Back"
            >
              <ArrowLeft className="size-4" />
            </Button>
          )}
          {!selectedCollection && (
            <Button
              onClick={() => void openProjectViaDialog()}
              variant="ghost"
              size="sm"
              className="size-7 p-0 text-muted-foreground"
              title="Open Project"
            >
              <FolderOpen className="size-4" />
            </Button>
          )}
          <div className="flex min-w-0 flex-1 items-center gap-1 text-sm font-medium text-foreground">
            {/* Collection name (always clickable to go to root) */}
            {selectedCollection && currentSubdirectory ? (
              <button
                onClick={() => handleBreadcrumbClick(null)}
                className="cursor-pointer truncate hover:underline"
              >
                {headerTitle}
              </button>
            ) : (
              <span className="truncate">{headerTitle}</span>
            )}

            {/* Breadcrumb segments */}
            {breadcrumbSegments.map((segment, index) => {
              const isLast = index === breadcrumbSegments.length - 1
              const pathUpToSegment = breadcrumbSegments
                .slice(0, index + 1)
                .join('/')

              return (
                <React.Fragment key={pathUpToSegment}>
                  <ChevronRight className="size-3 flex-shrink-0 text-muted-foreground" />
                  {isLast ? (
                    <span className="truncate text-muted-foreground">
                      {segment}
                    </span>
                  ) : (
                    <button
                      onClick={() => handleBreadcrumbClick(pathUpToSegment)}
                      className="cursor-pointer truncate hover:underline"
                    >
                      {segment}
                    </button>
                  )}
                </React.Fragment>
              )
            })}

            {/* Status indicators - composable badges, right-aligned */}
            {(showDraftsOnly ||
              (searchActive && !collectionViewState.filterBarExpanded) ||
              (sortActive && !collectionViewState.filterBarExpanded)) && (
              <div className="ml-auto flex items-center gap-1">
                {showDraftsOnly && (
                  <Badge
                    variant="outline"
                    className="h-4 border-draft px-1.5 py-0 text-[10px] font-normal text-draft opacity-80"
                  >
                    DRAFTS
                  </Badge>
                )}
                {searchActive && !collectionViewState.filterBarExpanded && (
                  <Badge
                    variant="outline"
                    className="h-4 border-filter px-1.5 py-0 text-[10px] font-normal text-filter opacity-80"
                  >
                    FILTERED
                  </Badge>
                )}
                {sortActive && !collectionViewState.filterBarExpanded && (
                  <Badge
                    variant="outline"
                    className="h-4 px-1.5 py-0 text-[10px] font-normal opacity-60"
                  >
                    SORTED
                  </Badge>
                )}
              </div>
            )}
          </div>
          {selectedCollection && (
            <>
              <Button
                onClick={handleToggleFilterBar}
                variant="ghost"
                size="sm"
                className={cn(
                  'size-7 p-0 [&_svg]:transform-gpu [&_svg]:scale-100 flex-shrink-0',
                  // Color priority: own active state > header color > expanded/sorted > default
                  searchActive
                    ? 'text-filter bg-filter-bg hover:bg-filter-bg/80'
                    : showDraftsOnly
                      ? 'text-draft hover:bg-draft-bg/50'
                      : collectionViewState.filterBarExpanded || sortActive
                        ? 'text-foreground bg-accent hover:bg-accent/80'
                        : 'text-muted-foreground hover:bg-muted'
                )}
                title={
                  collectionViewState.filterBarExpanded
                    ? 'Hide Filters'
                    : 'Show Filters'
                }
              >
                <SlidersHorizontal className="size-4" />
              </Button>
              <Button
                onClick={handleToggleDraftsOnly}
                variant="ghost"
                size="sm"
                className={cn(
                  'size-7 p-0 [&_svg]:transform-gpu [&_svg]:scale-100 flex-shrink-0',
                  // Color priority: own active state > header color > default
                  showDraftsOnly
                    ? 'text-draft bg-draft-bg hover:bg-draft-bg/80'
                    : searchActive
                      ? 'text-filter hover:bg-filter-bg/50'
                      : 'text-muted-foreground hover:bg-muted'
                )}
                title={showDraftsOnly ? 'Show All Files' : 'Show Drafts Only'}
              >
                {showDraftsOnly ? (
                  <Filter className="size-4" />
                ) : (
                  <FileText className="size-4" />
                )}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Filter Bar */}
      {selectedCollection && collectionViewState.filterBarExpanded && (
        <FilterBar
          searchQuery={collectionViewState.searchQuery}
          sortMode={collectionSort.mode}
          sortDirection={collectionSort.direction}
          sortOptions={sortOptions}
          onSearchChange={handleSearchChange}
          onSortModeChange={handleSortModeChange}
          onSortDirectionToggle={handleSortDirectionToggle}
          onClearSearch={handleClearSearch}
        />
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {!selectedCollection ? (
          // Collections List
          <div className="p-2">
            {collections.map(collection => {
              const fileCount = fileCounts[collection.name] ?? 0
              const hasSchema = Boolean(collection.complete_schema)

              return (
                <button
                  key={collection.name}
                  onClick={() => handleCollectionClick(collection)}
                  className="w-full rounded-md p-3 text-left transition-colors hover:bg-accent"
                >
                  <div className="flex w-full items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-foreground">
                        {collectionDisplayName(collection.name)}
                      </span>
                      {!hasSchema && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <AlertTriangle className="size-3.5 text-muted-foreground" />
                            }
                          />
                          <TooltipContent side="right">
                            No schema found - using defaults
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                    <Badge variant="secondary" className="text-xs">
                      {fileCount} item{fileCount !== 1 ? 's' : ''}
                    </Badge>
                  </div>
                  <div className="mt-1 font-mono text-xs text-muted-foreground">
                    {collection.path.split('/').pop()}
                  </div>
                </button>
              )
            })}
            {collections.length === 0 && (
              <div className="p-4 text-center text-sm text-muted-foreground">
                No collections found. Open an Astro project to get started.
              </div>
            )}
          </div>
        ) : (
          // Files List
          <div className="p-2">
            {/* Loading State */}
            {isLoadingDirectory && (
              <div className="p-4 text-center text-sm text-muted-foreground">
                Loading directory...
              </div>
            )}

            {/* Error State */}
            {hasDirectoryError && (
              <div className="p-4 text-center">
                <div className="mb-2 text-sm text-destructive">
                  Failed to load directory
                </div>
                <div className="mb-3 text-xs text-muted-foreground">
                  {directoryError instanceof Error
                    ? directoryError.message
                    : 'Unknown error occurred'}
                </div>
                <Button
                  onClick={() => void refetchFiles()}
                  variant="outline"
                  size="sm"
                >
                  Try Again
                </Button>
              </div>
            )}

            {/* Content (only show if not loading and no error) */}
            {!isLoadingDirectory && !hasDirectoryError && (
              <>
                {/* Subdirectories (alphabetically sorted) */}
                {subdirectories
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map(dir => (
                    <button
                      key={dir.relative_path}
                      onClick={() => handleSubdirectoryClick(dir.relative_path)}
                      className="mb-1 flex w-full items-center gap-2 rounded-md p-3 text-left transition-colors hover:bg-accent"
                    >
                      <Folder className="size-4 flex-shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium text-foreground">
                        {dir.name}
                      </span>
                    </button>
                  ))}

                {/* Files (sorted by date) */}
                {filteredAndSortedFiles.map(file => {
                  const isSelected = currentFile?.id === file.id

                  return (
                    <FileItem
                      key={file.id}
                      file={file}
                      isSelected={isSelected}
                      frontmatterMappings={frontmatterMappings}
                      onFileClick={handleFileClick}
                      onContextMenu={(e, f) => void handleContextMenu(e, f)}
                      onRenameSubmit={handleRenameSubmit}
                      isRenaming={renamingFileId === file.id}
                      onCancelRename={handleRenameCancel}
                    />
                  )
                })}
                {filteredAndSortedFiles.length === 0 &&
                  subdirectories.length === 0 && (
                    <div className="p-4 text-center text-sm text-muted-foreground">
                      {collectionViewState.searchQuery
                        ? 'No files match your search.'
                        : showDraftsOnly
                          ? 'No draft files found in this directory.'
                          : 'This directory is empty.'}
                    </div>
                  )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const TABS: { id: GitPanelTab; label: string }[] = [
  { id: 'files', label: 'Files' },
  { id: 'changes', label: 'Changes' },
]

/**
 * The left sidebar. With the publishing tools on, it has two tabs, Files and
 * Changes (the Git panel); both stay mounted and the hidden one is hidden
 * with CSS, so each keeps its scroll position and state.
 */
export const LeftSidebar: React.FC = () => {
  const toolsOn = useShowPublishingTools()
  const panelTab = useGitStore(state => state.panelTab)
  const projectPath = useProjectStore(state => state.projectPath)
  const changedCount = useGitStatusQuery(projectPath).data?.files.length ?? 0
  const tab = toolsOn ? panelTab : 'files'

  return (
    <div className="flex h-full flex-col border-r bg-background">
      {toolsOn && (
        <div
          role="tablist"
          aria-label="Sidebar"
          className="flex shrink-0 gap-1 border-b p-1.5"
        >
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => useGitStore.getState().setPanelTab(id)}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors',
                tab === id
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              )}
            >
              {label}
              {id === 'changes' && changedCount > 0 && (
                <span className="min-w-4 rounded-full bg-muted-foreground/15 px-1 text-[10px] leading-4">
                  {changedCount}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      <div className={cn('min-h-0 flex-1', tab !== 'files' && 'hidden')}>
        <FilesPanel />
      </div>
      {toolsOn && (
        <div className={cn('min-h-0 flex-1', tab !== 'changes' && 'hidden')}>
          {/* One per project: a draft message or notice stays with its project */}
          <ChangesPanel key={projectPath ?? 'none'} />
        </div>
      )}
    </div>
  )
}
