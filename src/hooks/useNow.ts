import { useEffect, useState } from 'react'

/** The current time, updated every `intervalMs`, for "3 min ago" labels. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(interval)
  }, [intervalMs])
  return now
}
