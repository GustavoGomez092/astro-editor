import React from 'react'
import { X } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldContent,
} from '@/components/ui/field'
import type { GrammarDialect } from '@/lib/bindings'
import { usePreferences } from '../../../hooks/usePreferences'
import {
  GRAMMAR_DIALECTS,
  removeWord,
  resolveGrammarSettings,
} from '../../../lib/grammar'
import type { GrammarSettings as GrammarSettingsValue } from '../../../lib/project-registry/types'
import { SettingsSection } from '../SettingsSection'

/**
 * Spelling and grammar in General preferences: on/off, the dialect, and the
 * words added to the personal dictionary. The whole `grammar` object is sent
 * on every change, because global settings replace it rather than merge it.
 */
export const GrammarSettings: React.FC = () => {
  const { globalSettings, updateGlobal } = usePreferences()
  const grammar = resolveGrammarSettings(globalSettings)
  const id = React.useId()

  const update = (change: GrammarSettingsValue) =>
    void updateGlobal({ grammar: { ...grammar, ...change } })

  return (
    <SettingsSection title="Spelling and Grammar">
      <Field>
        <div className="flex items-center justify-between gap-4">
          <div className="flex-1">
            <FieldLabel htmlFor={`${id}-enabled`}>
              Check spelling and grammar
            </FieldLabel>
            <FieldDescription>
              Underlines possible mistakes in the text as you write. Point at
              one or click it to see suggestions.
            </FieldDescription>
          </div>
          <Switch
            id={`${id}-enabled`}
            checked={grammar.enabled}
            onCheckedChange={checked => update({ enabled: checked })}
          />
        </div>
      </Field>

      <Field>
        <FieldLabel id={`${id}-dialect`}>English</FieldLabel>
        <FieldContent>
          <Select
            items={GRAMMAR_DIALECTS}
            value={grammar.dialect}
            onValueChange={(value: GrammarDialect | null) => {
              if (value) update({ dialect: value })
            }}
          >
            <SelectTrigger aria-labelledby={`${id}-dialect`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GRAMMAR_DIALECTS.map(item => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            Which spellings count as correct, such as “color” or “colour”
          </FieldDescription>
        </FieldContent>
      </Field>

      <Field>
        <FieldLabel id={`${id}-dictionary`}>Your dictionary</FieldLabel>
        <FieldContent>
          {grammar.dictionary.length > 0 ? (
            <ul
              aria-labelledby={`${id}-dictionary`}
              className="flex max-h-40 max-w-md flex-wrap gap-1.5 overflow-y-auto"
            >
              {grammar.dictionary.map(word => (
                <li
                  key={word}
                  className="flex items-center gap-0.5 rounded-md border bg-muted/50 py-0.5 pr-0.5 pl-2 text-sm"
                >
                  {word}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-5"
                    aria-label={`Remove ${word}`}
                    onClick={() =>
                      update({
                        dictionary: removeWord(grammar.dictionary, word),
                      })
                    }
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <FieldDescription>
            {grammar.dictionary.length > 0
              ? 'These words are never marked as misspelt. They’re kept on this computer, not in your project.'
              : 'No words yet. Choose Add to dictionary on a word marked as misspelt and it appears here.'}
          </FieldDescription>
        </FieldContent>
      </Field>
    </SettingsSection>
  )
}
