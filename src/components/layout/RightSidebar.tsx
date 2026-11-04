import React from 'react'
import { useGitBusy } from '../../hooks/useGitBusy'

interface RightSidebarProps {
  children: React.ReactNode
}

export const RightSidebar: React.FC<RightSidebarProps> = ({ children }) => {
  // No edits while git rewrites files: they'd be saved over what came in
  const gitBusy = useGitBusy()
  return (
    <div
      className="flex h-full min-w-0 flex-col overflow-hidden border-l border-border bg-background"
      inert={gitBusy || undefined}
      aria-busy={gitBusy || undefined}
    >
      {children}
    </div>
  )
}
