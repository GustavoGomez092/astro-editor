import { useProjectStore } from '../../store/projectStore'
import { PUBLISHING_TOOLS_DEFAULT } from '../../lib/project-registry/defaults'

/**
 * Whether the Git panel, Publish and Preview are switched on (General
 * preference, on by default in this fork). Everything they add is hidden when it's off.
 */
export const useShowPublishingTools = (): boolean =>
  useProjectStore(
    state =>
      state.globalSettings?.general.showPublishingTools ??
      PUBLISHING_TOOLS_DEFAULT
  )
