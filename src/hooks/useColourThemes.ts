import { useEffect } from 'react'
import { useProjectStore } from '../store/projectStore'
import { useThemeFiles } from '../store/themeFilesStore'
import { applyThemeCss, cssForChoice } from '../lib/themes'

/**
 * Keeps the page's colours in step with the chosen themes: loads the themes
 * folder at launch and applies the CSS whenever a choice or a file changes.
 */
export function useColourThemes() {
  const files = useThemeFiles(state => state.files)
  const filesLoaded = useThemeFiles(state => state.loaded)
  const lightId = useProjectStore(
    state => state.globalSettings?.appearance?.lightTheme
  )
  const darkId = useProjectStore(
    state => state.globalSettings?.appearance?.darkTheme
  )
  const settingsLoaded = useProjectStore(state => state.globalSettings !== null)

  useEffect(() => {
    void useThemeFiles.getState().loadFiles()
  }, [])

  useEffect(() => {
    // Until settings and themes load, leave the cached theme in place
    if (!settingsLoaded || !filesLoaded) return
    applyThemeCss(cssForChoice(files, lightId, darkId))
  }, [settingsLoaded, filesLoaded, files, lightId, darkId])
}
