import { useEffect } from 'react'
import { useProjectStore } from '../../store/projectStore'
import { refreshGrammar } from '../../lib/editor/extensions/grammar'

/**
 * Re-checks the open file's grammar and spelling as soon as their settings
 * change (switched off or on, another dialect, a word added or removed), so
 * the underlines don't wait for the next pause in typing.
 */
export function useGrammarRefresh() {
  useEffect(() => {
    let previous = useProjectStore.getState().globalSettings?.grammar
    return useProjectStore.subscribe(state => {
      const next = state.globalSettings?.grammar
      if (next === previous) return
      previous = next
      refreshGrammar()
    })
  }, [])
}
