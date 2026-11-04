import { error as logError } from '@tauri-apps/plugin-log'
import { openUrl } from '@tauri-apps/plugin-opener'
import { ExternalLink } from 'lucide-react'
import { commands, type DeviceCode } from '@/lib/bindings'
import { cancelGitHubSignIn, startGitHubSignIn } from '@/lib/git/sign-in'
import { useGitStore, type SignInState } from '@/store/gitStore'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { Spinner } from '../ui/spinner'

/** Copies the code, then opens GitHub's page for entering it. */
function copyCodeAndOpenGitHub(code: DeviceCode) {
  void commands.copyTextToClipboard(code.userCode).then(result => {
    if (result.status === 'error') {
      void logError(`Astro Editor [GIT] Copy code failed: ${result.error}`)
    }
  })
  void openUrl(code.verificationUri)
}

/**
 * Signing in to GitHub: a one-time code, shown large, that the writer enters
 * on github.com. The sheet waits until they approve it there. Opens from the
 * Git panel and from Preferences; `lib/git/sign-in.ts` drives it.
 */
export function SignInSheet() {
  const signIn = useGitStore(state => state.signIn)
  return <SignInDialog signIn={signIn} />
}

/** The sheet for a given sign-in state; also rendered by the styleguide. */
export function SignInDialog({ signIn }: { signIn: SignInState }) {
  return (
    <Dialog
      open={signIn.open}
      onOpenChange={open => {
        if (!open) cancelGitHubSignIn()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Sign in with GitHub</DialogTitle>
          <DialogDescription>
            So the app can sync and publish your site, and open pull requests.
          </DialogDescription>
        </DialogHeader>

        {signIn.step === 'starting' && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Spinner /> Getting a code from GitHub…
          </div>
        )}

        {signIn.step === 'waiting' && signIn.code && (
          <div className="space-y-5 py-2">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-foreground">
              <li>Copy this code and open GitHub.</li>
              <li>Paste the code there and approve.</li>
            </ol>
            <div
              aria-label="One-time code"
              className="rounded-lg border bg-muted/50 py-4 text-center font-mono text-3xl font-semibold tracking-[0.2em] text-heading select-text"
            >
              {signIn.code.userCode}
            </div>
            <Button
              className="w-full"
              onClick={() => copyCodeAndOpenGitHub(signIn.code!)}
            >
              <ExternalLink /> Copy code & open GitHub
            </Button>
            <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3" /> Waiting for you to approve on
              GitHub…
            </p>
          </div>
        )}

        {signIn.step === 'error' && (
          <div className="space-y-2 py-2">
            <p className="text-sm text-foreground">
              {signIn.error ?? "Signing in didn't work."}
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={cancelGitHubSignIn}>
            Cancel
          </Button>
          {signIn.step === 'error' && (
            <Button onClick={() => void startGitHubSignIn()}>Try again</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
