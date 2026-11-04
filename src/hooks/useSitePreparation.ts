import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { prepareSiteIfNeeded } from '@/lib/dev-server/prepare'
import { useProjectStore } from '../store/projectStore'
import { useCollectionsQuery } from './queries/useCollectionsQuery'
import { useShowPublishingTools } from './settings/useShowPublishingTools'

/**
 * With the preview and publishing tools on: once a project's collections
 * have loaded, prepares the site (dependencies, then `astro sync`) if it's an
 * Astro site whose collection schemas haven't been generated yet, so its
 * forms show every field. Each project is checked once per launch. Mount
 * once (Layout).
 */
export function useSitePreparation(projectPath: string | null): void {
  const enabled = useShowPublishingTools()
  const settings = useProjectStore(
    useShallow(state => state.currentProjectSettings)
  )
  const { data: collections } = useCollectionsQuery(projectPath, settings)

  // Runs again when the collections reload, but each project is only
  // checked the first time
  useEffect(() => {
    if (!enabled || !projectPath || !collections) return
    void prepareSiteIfNeeded(projectPath, collections)
  }, [enabled, projectPath, collections])
}
