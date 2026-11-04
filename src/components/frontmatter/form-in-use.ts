import React from 'react'

/**
 * Whether the frontmatter form a field is in is the copy in use. The form is
 * mounted twice, in the right sidebar and in the main area (`FrontmatterPanel`
 * `placement`), and only one shows. Fields in the hidden copy skip fixed ids
 * such as the title field's, so those stay unique in the page.
 */
export const FormInUseContext = React.createContext(true)
