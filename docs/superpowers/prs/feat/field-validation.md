# Check frontmatter values against the schema

Nothing in the form says when a value won't pass the project's schema. An email field happily takes `kevin@`, a number with `.min(0).max(95)` takes 140, a required image stays empty, and the writer only finds out when the site's build fails, often much later and somewhere else.

Values are now checked against the collection's schema, without ever blocking a save:

- **What's checked** (`lib/frontmatter-validation.ts`): required fields, email and URL formats, number bounds (exclusive ones too) and whole numbers, text length, list length, and enum options. A required field inside an object that isn't there is skipped, because the flattened fields don't say whether the object itself is optional.
- **When:** a field shows its message once the writer leaves it. Focus moving into the field's own popup (a select or date picker) doesn't count. The message is worked out from the current value, so it goes as soon as the value is fixed. Opening another file clears them.
- **On save:** an explicit save (Cmd+S, File → Save, the toolbar) writes the file as before, then shows the message under every field that needs attention and a warning toast, "Saved, but 2 fields need attention", in place of the success toast. Auto-save stays quiet, so fields the writer hasn't reached yet don't light up while they type. Because auto-save has usually saved the file by the time the writer presses Cmd+S, Cmd+S and File → Save now also run on a saved file: it isn't written again, but the fields are still reported.

The JSON schema Astro generates is looser than Astro's own checks (refinements and transforms leave no trace), so a clean form doesn't promise the build passes, but the common mistakes are caught.

- Tests for the validator (`frontmatter-validation.test.ts`), the messages in `FrontmatterField` (shown after blur, cleared when fixed), the save (warning and messages on an explicit save, nothing on auto-save, the usual toast when everything's fine), and the store (cleared on file open).
- `ui-patterns.md` and the website's frontmatter overview describe it.

Checked in the dev app on a collection with a required image, a bounded integer, an email, a URL and a required enum: entering `kevin@` and 99 showed nothing until each field was left, then "Enter an email address, like name@example.com" and "Must be at least 100"; picking from the enum's popup didn't trigger a message, and clearing it then leaving gave "Required"; Cmd+S on the already auto-saved file showed all three and "Saved, but 3 fields need attention"; fixing the width cleared its message at once; opening another file and back cleared them all. Light and dark.
