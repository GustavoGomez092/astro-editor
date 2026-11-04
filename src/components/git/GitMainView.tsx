import { useEffect } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { ArrowLeft, X } from 'lucide-react'
import { useProjectStore } from '../../store/projectStore'
import { useGitStore } from '../../store/gitStore'
import { useEditorStore } from '../../store/editorStore'
import { useShowPublishingTools } from '../../hooks/settings/useShowPublishingTools'
import { useGitLogQuery } from '../../hooks/queries/useGitLogQuery'
import {
  useGitCommitDetailsQuery,
  useGitCommitFileDiffQuery,
  useGitFileDiffQuery,
} from '../../hooks/queries/useGitCommitQueries'
import { useGitStatusQuery } from '../../hooks/queries/useGitStatusQuery'
import { Button } from '../ui/button'
import { Spinner } from '../ui/spinner'
import { CommitDetails } from './CommitDetails'
import { CommitGraph } from './CommitGraph'
import { DiffView } from './DiffView'

const closeMainView = () => useGitStore.getState().closeMainView()

/**
 * A changed file's diff, or History, shown over the editor (which stays
 * mounted underneath). Escape or the close button returns to the editor, and
 * so does opening a file.
 */
export function GitMainView() {
  const toolsOn = useShowPublishingTools()
  const diffPath = useGitStore(state => state.selectedDiffPath)
  const historyOpen = useGitStore(state => state.historyOpen)
  const open = toolsOn && (diffPath !== null || historyOpen)
  const currentFileId = useEditorStore(state => state.currentFile?.id ?? null)

  // Opening a file goes back to the editor
  useEffect(() => {
    closeMainView()
  }, [currentFileId])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) closeMainView()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  if (!open) return null
  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-editor-background">
      {historyOpen ? <HistoryView /> : <WorkingDiff path={diffPath!} />}
    </div>
  )
}

function Header({
  title,
  onBack,
  backLabel,
}: {
  title: string
  onBack?: () => void
  backLabel?: string
}) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b bg-background px-2">
      {onBack && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-icon"
          onClick={onBack}
        >
          <ArrowLeft className="size-4" /> {backLabel}
        </Button>
      )}
      <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium text-foreground">
        {title}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="size-7 p-0 text-icon [&_svg]:scale-100 [&_svg]:transform-gpu"
        title="Back to the editor (Esc)"
        aria-label="Close"
        onClick={closeMainView}
      >
        <X className="size-4" />
      </Button>
    </div>
  )
}

function Loading() {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Spinner /> Loading…
    </div>
  )
}

function Failed({ message }: { message: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {message}
    </div>
  )
}

function WorkingDiff({ path }: { path: string }) {
  const projectPath = useProjectStore(state => state.projectPath)
  const diff = useGitFileDiffQuery(projectPath, path)
  const file = useGitStatusQuery(projectPath).data?.files.find(
    f => f.path === path
  )
  const exists = file?.change !== 'deleted'
  const afterSrc =
    projectPath && exists && diff.data?.isImage
      ? convertFileSrc(`${projectPath.replace(/\/+$/, '')}/${path}`)
      : null

  return (
    <>
      <Header title="Changes since the last publish" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {diff.isPending ? (
          <Loading />
        ) : diff.error ? (
          <Failed message={diff.error.message} />
        ) : (
          <DiffView
            diff={diff.data}
            afterSrc={afterSrc}
            change={file?.change}
          />
        )}
      </div>
    </>
  )
}

function HistoryView() {
  const projectPath = useProjectStore(state => state.projectPath)
  const selectedId = useGitStore(state => state.selectedCommitId)
  const selectedFile = useGitStore(state => state.selectedCommitFilePath)
  const log = useGitLogQuery(projectPath)
  const currentBranch = useGitStatusQuery(projectPath).data?.branch ?? null
  const details = useGitCommitDetailsQuery(projectPath, selectedId)
  const fileDiff = useGitCommitFileDiffQuery(
    projectPath,
    selectedId,
    selectedFile
  )

  return (
    <>
      <Header
        title={selectedFile ? (details.data?.summary ?? 'History') : 'History'}
        onBack={
          selectedFile
            ? () => useGitStore.getState().selectCommitFile(null)
            : undefined
        }
        backLabel="All commits"
      />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          {selectedFile ? (
            fileDiff.isPending ? (
              <Loading />
            ) : fileDiff.error ? (
              <Failed message={fileDiff.error.message} />
            ) : (
              <DiffView
                diff={fileDiff.data}
                change={
                  details.data?.files.find(f => f.path === selectedFile)?.change
                }
              />
            )
          ) : log.isPending ? (
            <Loading />
          ) : log.error ? (
            <Failed message={log.error.message} />
          ) : log.data.length === 0 ? (
            <Failed message="No commits yet. Publish to make the first one." />
          ) : (
            <div className="py-1">
              <CommitGraph
                commits={log.data}
                selectedId={selectedId}
                onSelect={id => useGitStore.getState().selectCommit(id)}
                currentBranch={currentBranch}
              />
            </div>
          )}
        </div>
        <aside className="w-80 shrink-0 overflow-y-auto border-l bg-background">
          {!selectedId ? (
            <p className="p-4 text-sm text-muted-foreground">
              Choose a commit to see what changed.
            </p>
          ) : details.isPending ? (
            <Loading />
          ) : details.error ? (
            <Failed message={details.error.message} />
          ) : (
            <CommitDetails
              details={details.data}
              selectedPath={selectedFile}
              onSelectFile={path =>
                useGitStore.getState().selectCommitFile(path)
              }
            />
          )}
        </aside>
      </div>
    </>
  )
}
