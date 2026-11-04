// The saves that are running right now, so something that is about to move or
// replace the open file (a rename) can wait for them: a save that finishes
// after the rename would write the old path and bring the old file back.

const pending = new Set<Promise<unknown>>()

/** Registers a save; returns it unchanged */
export function trackSave<T>(save: Promise<T>): Promise<T> {
  pending.add(save)
  const done = () => {
    pending.delete(save)
  }
  save.then(done, done)
  return save
}

/** Resolves once no save is running, whether they worked or not */
export async function waitForSaves(): Promise<void> {
  while (pending.size > 0) {
    await Promise.allSettled([...pending])
  }
}
