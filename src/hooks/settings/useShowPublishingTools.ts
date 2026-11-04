import { useProjectStore } from '../../store/projectStore'

/**
 * Whether the Git panel, Publish and Preview are switched on (General
 * preference, off by default). Everything they add is hidden when it's off.
 */
export const useShowPublishingTools = (): boolean =>
  useProjectStore(
    state => state.globalSettings?.general.showPublishingTools ?? false
  )
