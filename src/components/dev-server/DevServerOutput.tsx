import React from 'react'
import { Copy } from 'lucide-react'
import type { DevServerState } from '@/lib/bindings'
import { Button } from '../ui/button'
import {
  copyServerOutput,
  needsNode,
  NODE_DOWNLOAD_URL,
  openInBrowser,
} from '../../lib/dev-server'

interface DevServerOutputProps {
  state: DevServerState
  lines: string[]
}

/**
 * The output popover's content: the server's last ~200 lines, newest at the
 * bottom, and a Copy button.
 */
export const DevServerOutput: React.FC<DevServerOutputProps> = ({
  state,
  lines,
}) => {
  const scrollRef = React.useRef<HTMLPreElement>(null)

  // Follow new output, like a terminal
  React.useEffect(() => {
    const pre = scrollRef.current
    if (pre) pre.scrollTop = pre.scrollHeight
  }, [lines])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-heading">Server output</h3>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={lines.length === 0}
          onClick={() => void copyServerOutput(lines)}
        >
          <Copy className="size-3.5" />
          Copy
        </Button>
      </div>

      {state.command && (
        <p className="truncate text-xs text-muted-foreground">
          <code>{state.command}</code>
        </p>
      )}

      {state.status === 'error' && state.error && (
        <p className="text-xs text-server-error">
          {state.error.split('\n')[0]}
        </p>
      )}

      {needsNode(state.error) && (
        <p className="text-xs">
          <a
            href={NODE_DOWNLOAD_URL}
            onClick={e => {
              e.preventDefault()
              openInBrowser(NODE_DOWNLOAD_URL)
            }}
            className="cursor-pointer underline underline-offset-4 hover:text-primary"
          >
            Get Node.js
          </a>
        </p>
      )}

      <pre
        ref={scrollRef}
        className="max-h-72 min-h-24 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-snug break-words whitespace-pre-wrap select-text"
      >
        {lines.length > 0 ? lines.join('\n') : 'No output yet.'}
      </pre>
    </div>
  )
}
