# Order sorts ascending, and each collection remembers its sort

Choosing **Order** in the sidebar sorted descending, so a collection numbered 1, 2, 3 came out 3, 2, 1, and every sort started descending whatever it was (Title went Z to A). The choice also lived only in memory, so it went back to Default each time the app started, and a site whose sections are meant to be read in order had to be re-sorted every session.

- Each sort starts in its natural direction: Order, Title and Filename ascending, dates and Last Modified newest first (`defaultSortDirection`). The arrow still flips it.
- The sort is saved per collection in the project settings (`sort: { mode, direction }` on the collection's settings), so it survives a restart. The Default sort isn't stored. It moves out of `uiStore`'s session-only view state, which keeps search and the filter bar.
- The cleanup that drops empty collection entries is now one function, `hasCollectionSettings`, used by the preferences pane and the sort, so a collection whose only setting is its sort isn't dropped when another collection's settings change.

- Tests for the default directions (`sorting.test.ts`) and for reading, saving and clearing a collection's sort and the cleanup (`collection-settings.test.ts`).
- `app-data.md` and the website's sorting page describe it.

Checked in the dev app on a collection with an integer `order`: choosing Order listed 1, 2, 3 with the arrow on Ascending; the arrow flipped it to 3, 2, 1; after quitting and relaunching the app the collection opened sorted 3, 2, 1; Title started ascending; choosing Default removed the saved sort from the project settings file.
