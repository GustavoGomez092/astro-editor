import React, { useCallback, useEffect } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from '@/components/ui/field'
import { commands } from '@/lib/bindings'
import { toast } from '@/lib/toast'
import { usePreferences } from '../../hooks/usePreferences'
import {
  availableThemes,
  pickTheme,
  themesForScheme,
  type Scheme,
  type Theme,
} from '../../lib/themes'
import { resolveTokens } from '../../lib/themes/css'
import { useThemeFiles } from '../../store/themeFilesStore'

/** A small preview of a theme: the writing surface, with its text, main and status colours */
const Swatch: React.FC<{ theme: Theme; scheme: Scheme }> = ({
  theme,
  scheme,
}) => {
  const c = resolveTokens(theme, scheme)
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-1"
      style={{
        background: c['editor-color-background'],
        borderColor: c['border'],
      }}
    >
      {['editor-color-text', 'primary', 'filter', 'draft'].map(token => (
        <span
          key={token}
          className="size-2.5 rounded-full"
          style={{ background: c[token] }}
        />
      ))}
    </span>
  )
}

const ThemeField: React.FC<{
  scheme: Scheme
  label: string
  themes: Theme[]
  value: string | undefined
  onChange: (id: string) => void
}> = ({ scheme, label, themes, value, onChange }) => {
  const labelId = React.useId()
  const choices = themesForScheme(themes, scheme)
  const current = pickTheme(themes, value, scheme)
  const items = choices.map(t => ({ value: t.id, label: t.name }))
  return (
    <Field>
      <FieldLabel id={labelId}>{label}</FieldLabel>
      <FieldContent>
        <div className="flex items-center gap-3">
          <Select
            items={items}
            value={current.id}
            onValueChange={id => id && onChange(id)}
          >
            <SelectTrigger aria-labelledby={labelId} className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map(t => (
                <SelectItem key={t.id} value={t.id}>
                  <span className="flex items-center gap-2">
                    <Swatch theme={t} scheme={scheme} />
                    {t.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Swatch theme={current} scheme={scheme} />
        </div>
      </FieldContent>
    </Field>
  )
}

export const ThemePicker: React.FC = () => {
  const { globalSettings, updateGlobal } = usePreferences()
  const files = useThemeFiles(state => state.files)
  const themes = availableThemes(files)

  // Pick up themes added to the folder since the app started
  useEffect(() => {
    void useThemeFiles.getState().loadFiles()
  }, [])

  const choose = useCallback(
    (scheme: Scheme, id: string) => {
      void updateGlobal({
        appearance: scheme === 'light' ? { lightTheme: id } : { darkTheme: id },
      })
    },
    [updateGlobal]
  )

  const showFolder = useCallback(() => {
    void (async () => {
      const result = await commands.openThemesFolder()
      if (result.status === 'error') {
        toast.error('Could not open the themes folder', {
          description: result.error,
        })
      }
    })()
  }, [])

  const broken = files.flatMap(f => (f.ok ? [] : [f]))
  const warned = files.flatMap(f => (f.ok && f.warnings.length ? [f] : []))

  return (
    <>
      <ThemeField
        scheme="light"
        label="Colours in light mode"
        themes={themes}
        value={globalSettings?.appearance?.lightTheme}
        onChange={id => choose('light', id)}
      />
      <ThemeField
        scheme="dark"
        label="Colours in dark mode"
        themes={themes}
        value={globalSettings?.appearance?.darkTheme}
        onChange={id => choose('dark', id)}
      />
      <Field>
        <FieldContent>
          <div>
            <Button variant="outline" size="sm" onClick={showFolder}>
              Show themes folder
            </Button>
          </div>
          <FieldDescription>
            Add your own colours by putting a theme file (.json) in this folder.
            The Light, Dark or System choice above still decides which one is
            used.
          </FieldDescription>
          {broken.length > 0 && (
            <div
              role="alert"
              className="space-y-2 rounded-md border border-required/40 bg-muted/50 p-3 text-sm"
            >
              <p className="font-medium text-required">
                {broken.length === 1
                  ? 'This theme file can’t be used:'
                  : 'These theme files can’t be used:'}
              </p>
              {broken.map(f => (
                <div key={f.file}>
                  <p className="font-medium text-foreground">{f.file}</p>
                  <ul className="list-disc pl-5 text-muted-foreground">
                    {!f.ok && f.errors.map(e => <li key={e}>{e}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          )}
          {warned.length > 0 && (
            <div className="space-y-2 text-sm text-muted-foreground">
              {warned.map(f => (
                <div key={f.file}>
                  <p className="font-medium text-foreground">{f.file}</p>
                  <ul className="list-disc pl-5">
                    {f.ok && f.warnings.map(w => <li key={w}>{w}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </FieldContent>
      </Field>
    </>
  )
}
