import type { DevServerState } from '@/lib/bindings'
import { DevServerOutput, PreviewControl } from '../components/dev-server'

const base: DevServerState = {
  status: 'stopped',
  url: null,
  command: 'npm run dev',
  pid: null,
  error: null,
}

const STATES: { label: string; state: DevServerState }[] = [
  { label: 'Stopped', state: base },
  { label: 'Installing', state: { ...base, status: 'installing', pid: 4242 } },
  { label: 'Starting', state: { ...base, status: 'starting', pid: 4242 } },
  {
    label: 'Running',
    state: {
      ...base,
      status: 'running',
      pid: 4242,
      url: 'http://localhost:4321/',
    },
  },
  {
    label: 'External',
    state: { ...base, status: 'external', url: 'http://localhost:4321/' },
  },
  {
    label: 'Error',
    state: {
      ...base,
      status: 'error',
      error:
        "Couldn't find npm. Install Node.js from https://nodejs.org, then try again.\n\nzsh:1: command not found: npm",
    },
  },
]

const LINES = [
  '> w3-dev-server-proj@0.0.1 dev',
  '> astro dev',
  '',
  ' astro  v7.4.2 ready in 312 ms',
  '',
  '┃ Local    http://localhost:4321/',
  '┃ Network  use --host to expose',
  '',
  '12:04:31 watching for file changes...',
]

const noop = () => {}

/** The title bar's Preview control in each state, and its output popover */
export function DevServerSection() {
  return (
    <div className="space-y-5">
      {STATES.map(({ label, state }) => (
        <div key={label} className="flex items-center gap-6">
          <div className="w-32 shrink-0 text-xs text-muted-foreground">
            {label}
          </div>
          <div className="rounded-md border bg-background px-3 py-1.5">
            <PreviewControl
              state={state}
              lines={[]}
              outputOpen={false}
              onOutputOpenChange={noop}
              onStart={noop}
              onStop={noop}
            />
          </div>
        </div>
      ))}
      <div className="flex items-start gap-6">
        <div className="w-32 shrink-0 text-xs text-muted-foreground">
          Output popover, running and Node missing
        </div>
        <div className="flex gap-4">
          <div className="w-[32rem] rounded-md border bg-popover p-3 text-popover-foreground shadow-md">
            <DevServerOutput state={STATES[3]!.state} lines={LINES} />
          </div>
          <div className="w-[32rem] rounded-md border bg-popover p-3 text-popover-foreground shadow-md">
            <DevServerOutput
              state={STATES[5]!.state}
              lines={['zsh:1: command not found: npm']}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
