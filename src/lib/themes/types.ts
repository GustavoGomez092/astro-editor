/** A colour for one token: one value for both modes, or one for each */
export type ThemeTokenValue = string | { light?: string; dark?: string }

export type ThemeAppearance = 'light' | 'dark' | 'both'

export interface Theme {
  id: string
  name: string
  author: string
  appearance: ThemeAppearance
  tokens: Record<string, ThemeTokenValue>
}

export type Scheme = 'light' | 'dark'

/** A theme file in the themes folder: the theme, or why it can't be used */
export type ThemeFile =
  | { file: string; ok: true; theme: Theme; warnings: string[] }
  | { file: string; ok: false; errors: string[] }
