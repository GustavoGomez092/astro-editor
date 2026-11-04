import { commands } from '@/lib/bindings'
import { queryClient } from '@/lib/query-client'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'
import { useGitStore } from '@/store/gitStore'

/** Bumped by each start and cancel, so a stale wait can't touch the sheet. */
let attempt = 0

/**
 * GitHub's device flow, as the sign-in sheet shows it: ask for a one-time
 * code, show it, and wait (the Rust side polls) until the writer approves it
 * on github.com, it expires, or they deny it.
 */
export async function startGitHubSignIn(): Promise<void> {
  const current = ++attempt
  const { setSignIn } = useGitStore.getState()
  setSignIn({ open: true, step: 'starting' })

  const started = await commands.githubDeviceStart()
  if (current !== attempt) return
  if (started.status === 'error') {
    setSignIn({ step: 'error', error: started.error })
    return
  }
  setSignIn({ step: 'waiting', code: started.data })

  const polled = await commands.githubDevicePoll()
  if (current !== attempt) return
  if (polled.status === 'error') {
    setSignIn({ step: 'error', error: polled.error })
    return
  }

  queryClient.setQueryData(queryKeys.githubAuth, polled.data)
  // Signed in: fetch, pull requests and repositories can load now
  void queryClient.invalidateQueries({
    predicate: ({ queryKey }) =>
      queryKey[0] === queryKeys.githubRepos[0] ||
      (queryKey[0] === queryKeys.all[0] && queryKey[2] === 'git'),
  })
  setSignIn({ open: false })
  toast.success(`Signed in as ${polled.data.login ?? 'GitHub user'}`)
}

/**
 * Closes the sheet. A wait in progress is stopped on the Rust side too; a
 * sign-in that's already stored is kept (this never signs out).
 */
export function cancelGitHubSignIn(): void {
  const { signIn, setSignIn } = useGitStore.getState()
  attempt++
  if (signIn.step !== 'error') void commands.githubCancelSignIn()
  setSignIn({ open: false })
}

/** Signs out and forgets the token. */
export async function signOutOfGitHub(): Promise<void> {
  const result = await commands.githubSignOut()
  if (result.status === 'error') {
    toast.error("Couldn't sign out", { description: result.error })
    return
  }
  queryClient.setQueryData(queryKeys.githubAuth, {
    signedIn: false,
    login: null,
    name: null,
    avatarUrl: null,
  })
  void queryClient.invalidateQueries({
    predicate: ({ queryKey }) =>
      queryKey[0] === queryKeys.all[0] && queryKey[2] === 'git',
  })
}
