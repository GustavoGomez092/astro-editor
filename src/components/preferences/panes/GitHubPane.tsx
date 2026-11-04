import React from 'react'
import { LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { signOutOfGitHub, startGitHubSignIn } from '@/lib/git/sign-in'
import { usePreferences } from '../../../hooks/usePreferences'
import { useGitHubAuthQuery } from '../../../hooks/queries/useGitHubAuthQuery'
import { SettingsSection } from '../SettingsSection'
import { PreferencesTextInput } from '../PreferencesTextInput'

/** GitHub sign-in for Sync, Publish and pull requests. */
export const GitHubPane: React.FC = () => {
  const auth = useGitHubAuthQuery()
  const status = auth.data

  return (
    <div className="space-y-6">
      <SettingsSection title="Account">
        {auth.isPending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Checking…
          </div>
        ) : status?.signedIn ? (
          <div className="flex items-center gap-3">
            {status.avatarUrl && (
              <img
                src={status.avatarUrl}
                alt=""
                className="size-10 rounded-full border"
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-foreground">
                {status.name ?? status.login}
              </div>
              {status.login && (
                <div className="truncate text-xs text-muted-foreground">
                  @{status.login}
                </div>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void signOutOfGitHub()}
            >
              <LogOut /> Sign out
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Sign in so the app can sync and publish your site, and open and
              merge pull requests. Your sign-in is kept in the macOS Keychain.
            </p>
            {auth.error && (
              <p className="text-sm text-foreground">{auth.error.message}</p>
            )}
            <Button size="sm" onClick={() => void startGitHubSignIn()}>
              Sign in with GitHub
            </Button>
          </div>
        )}
      </SettingsSection>
    </div>
  )
}

/**
 * The OAuth client ID override, for builds compiled without one. It's in the
 * Advanced pane, where the "no client ID" sign-in error points.
 */
export const GitHubClientIdSection: React.FC = () => {
  const { globalSettings, updateGlobal } = usePreferences()
  const id = React.useId()
  return (
    <SettingsSection title="GitHub">
      <Field>
        <FieldLabel htmlFor={`${id}-client-id`}>
          GitHub app client ID
        </FieldLabel>
        <FieldContent>
          <PreferencesTextInput
            id={`${id}-client-id`}
            value={globalSettings?.advanced?.githubClientId ?? ''}
            onCommit={value =>
              void updateGlobal({
                advanced: { githubClientId: value.trim() || null },
              })
            }
            placeholder="Built in"
            className="max-w-md font-mono"
          />
          <FieldDescription>
            For GitHub sign-in. Only needed if signing in says this build has no
            client ID. Leave empty to use the one this app was built with.
          </FieldDescription>
        </FieldContent>
      </Field>
    </SettingsSection>
  )
}
