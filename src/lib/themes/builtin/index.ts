import type { Theme } from '../types'
import defaultTheme from './default.json'
import catppuccin from './catppuccin.json'
import nord from './nord.json'

export const DEFAULT_THEME_ID = 'default'

/** The Default theme is complete: it holds every token's value from App.css */
export const DEFAULT_THEME = defaultTheme as Theme

export const BUILTIN_THEMES: Theme[] = [
  DEFAULT_THEME,
  catppuccin as Theme,
  nord as Theme,
]
