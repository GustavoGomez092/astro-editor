import { CloudUpload } from 'lucide-react'
import { useProjectStore } from '../../store/projectStore'
import { useGitStore } from '../../store/gitStore'
import { useUIStore } from '../../store/uiStore'
import { useShowPublishingTools } from '../../hooks/settings/useShowPublishingTools'
import { useGitStatusQuery } from '../../hooks/queries/useGitStatusQuery'
import { Button } from '../ui/button'

/** Shows the Changes tab, opening the sidebar if it's closed. */
function showChanges() {
  useUIStore.getState().setSidebarVisible(true)
  useGitStore.getState().setPanelTab('changes')
}

/**
 * Publish in the title bar, with the number of changed files. It opens the
 * Changes tab, where the writer reviews the changes and publishes them.
 */
export function PublishButton() {
  const toolsOn = useShowPublishingTools()
  const projectPath = useProjectStore(state => state.projectPath)
  const status = useGitStatusQuery(projectPath).data
  if (!toolsOn || !projectPath || !status?.isRepo) return null

  const count = status.files.length
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 gap-1.5 px-2 text-xs text-icon"
      onClick={showChanges}
      title={
        count > 0
          ? `${count} changed ${count === 1 ? 'file' : 'files'}. Review and publish`
          : 'Review and publish'
      }
    >
      <CloudUpload className="size-4" />
      Publish
      {count > 0 && (
        <span className="min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 font-semibold text-primary-foreground">
          {count}
        </span>
      )}
    </Button>
  )
}
