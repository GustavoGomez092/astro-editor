import React from 'react'
import { ExternalLink, Play, Square } from 'lucide-react'
import type { DevServerState } from '@/lib/bindings'
import { useProjectStore } from '../../store/projectStore'
import { PUBLISHING_TOOLS_DEFAULT } from '../../lib/project-registry/defaults'
import { useDevServer, useDevServerLogs } from '../../hooks/useDevServer'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Spinner } from '../ui/spinner'
import { cn } from '../../lib/utils'
import { toast } from '../../lib/toast'
import {
  EXTERNAL_LABEL,
  isBusy,
  openInBrowser,
  previewTitle,
  startDevServer,
  statusLabel,
  stopDevServer,
} from '../../lib/dev-server'
import { DevServerOutput } from './DevServerOutput'

const iconButton =
  'h-7 gap-1.5 px-2 text-xs text-icon [&_svg]:scale-100 [&_svg]:transform-gpu'

/**
 * The title bar's Preview control: starts the project's dev server, opens the
 * site in the browser and stops it. A status dot opens the server's output.
 * Shown only with the "Show preview and publishing tools" preference on.
 */
export const PreviewButton: React.FC = () => {
  const projectPath = useProjectStore(state => state.projectPath)
  const enabled = useProjectStore(
    state =>
      state.globalSettings?.general?.showPublishingTools ??
      PUBLISHING_TOOLS_DEFAULT
  )
  const [outputOpen, setOutputOpen] = React.useState(false)
  const activePath = enabled ? projectPath : null
  const state = useDevServer(activePath)

  // A stopped server has no status dot, so close its output with it;
  // otherwise it reopens on the next start and its logs keep polling
  const [previousStatus, setPreviousStatus] = React.useState(state.status)
  if (state.status !== previousStatus) {
    setPreviousStatus(state.status)
    if (state.status === 'stopped') setOutputOpen(false)
  }

  const lines = useDevServerLogs(
    activePath,
    outputOpen && state.status !== 'stopped'
  )

  if (!activePath) return null

  return (
    <PreviewControl
      state={state}
      lines={lines}
      outputOpen={outputOpen}
      onOutputOpenChange={setOutputOpen}
      onStart={() => void startDevServer(activePath)}
      onStop={() => {
        if (state.status === 'external') {
          toast.info('This server was started in another window or terminal', {
            description:
              'Stop it there. Astro Editor can only stop servers it started.',
          })
        }
        void stopDevServer(activePath)
      }}
    />
  )
}

interface PreviewControlProps {
  state: DevServerState
  lines: string[]
  outputOpen: boolean
  onOutputOpenChange: (open: boolean) => void
  onStart: () => void
  onStop: () => void
}

/** The control for one state, without the store and queries (styleguide) */
export const PreviewControl: React.FC<PreviewControlProps> = ({
  state,
  lines,
  outputOpen,
  onOutputOpenChange,
  onStart,
  onStop,
}) => {
  const { status } = state
  const running = status === 'running' || status === 'external'

  return (
    <div className="flex items-center gap-1" data-tauri-drag-region>
      {status !== 'stopped' && (
        <Popover open={outputOpen} onOpenChange={onOutputOpenChange}>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="size-7 p-0"
                title={statusLabel(state)}
                aria-label={`Server output. ${statusLabel(state)}`}
              />
            }
          >
            <span
              data-status={status}
              className={cn(
                'size-2 rounded-full',
                status === 'running' && 'bg-server-running',
                // Hollow: a server Astro Editor didn't start
                status === 'external' && 'border-2 border-server-running',
                status === 'error' && 'bg-server-error',
                isBusy(status) && 'animate-pulse bg-muted-foreground'
              )}
            />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[32rem] p-3">
            <DevServerOutput state={state} lines={lines} />
          </PopoverContent>
        </Popover>
      )}

      {(status === 'stopped' || status === 'error') && (
        <Button
          variant="ghost"
          size="sm"
          className={iconButton}
          title={previewTitle(state)}
          onClick={onStart}
        >
          <Play className="size-4" />
          Preview
        </Button>
      )}

      {isBusy(status) && (
        <>
          <span className="flex h-7 items-center gap-1.5 px-2 text-xs text-muted-foreground">
            <Spinner className="size-4" />
            {status === 'installing' ? 'Installing…' : 'Starting…'}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="size-7 p-0 text-icon"
            title="Stop"
            aria-label="Stop"
            onClick={onStop}
          >
            <Square className="size-3.5" />
          </Button>
        </>
      )}

      {running && (
        <div className="flex h-7 items-center rounded-md border">
          <Button
            variant="ghost"
            size="sm"
            className={cn(iconButton, 'h-full rounded-r-none')}
            title={state.url ?? undefined}
            disabled={!state.url}
            onClick={() => state.url && openInBrowser(state.url)}
          >
            <ExternalLink className="size-4" />
            Open site
          </Button>
          <div className="h-4 w-px bg-border" />
          <Button
            variant="ghost"
            size="sm"
            className={cn(iconButton, 'h-full rounded-l-none')}
            title={
              status === 'external' ? EXTERNAL_LABEL : 'Stop the dev server'
            }
            onClick={onStop}
          >
            <Square className="size-3.5" />
            Stop
          </Button>
        </div>
      )}
    </div>
  )
}
