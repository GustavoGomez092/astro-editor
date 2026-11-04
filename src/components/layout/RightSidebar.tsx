import React from 'react'
import { useGitEditGuard } from '../../hooks/useGitEditGuard'

interface RightSidebarProps {
  children: React.ReactNode
}

export const RightSidebar: React.FC<RightSidebarProps> = ({ children }) => {
  // No edits while git rewrites files: they'd be saved over what came in
  const gitGuard = useGitEditGuard()
  return (
    <div
      className="flex h-full min-w-0 flex-col overflow-hidden border-l border-border bg-background"
      {...gitGuard}
    >
      {children}
    </div>
  )
}
