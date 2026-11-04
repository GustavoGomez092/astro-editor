import { describe, expect, it } from 'vitest'
import { trackSave, waitForSaves } from './pending-saves'

describe('pending saves', () => {
  it('waits for a running save, even one that fails', async () => {
    let finish: () => void = () => {}
    const events: string[] = []
    void trackSave(
      new Promise<void>((_, reject) => {
        finish = () => {
          events.push('save done')
          reject(new Error('disk full'))
        }
      })
    ).catch(() => {})

    setTimeout(finish, 5)
    await waitForSaves()
    events.push('after wait')

    expect(events).toEqual(['save done', 'after wait'])
  })

  it('returns at once when nothing is saving', async () => {
    await expect(waitForSaves()).resolves.toBeUndefined()
  })
})
