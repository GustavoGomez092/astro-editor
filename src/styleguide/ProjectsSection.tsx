import { ProjectsDialog } from '../components/projects/ProjectsDialog'
import { commands } from '../lib/bindings'
import { projectRegistryManager } from '../lib/project-registry'
import type { ProjectMetadata } from '../lib/project-registry/types'
import { useProjectStore } from '../store/projectStore'
import { useProjectsScreenStore } from '../store/projectsScreenStore'

const DAY = 24 * 3600 * 1000

const PROJECTS: ProjectMetadata[] = [
  ['kevin-robinson-site', '/Users/kevin/Sites/kevin-robinson', 0.1],
  ['studio-journal', '/Users/kevin/Sites/studio-journal', 2],
  ['type-specimens', '/Users/kevin/Work/type-specimens', 9],
  ['old-portfolio', '/Users/kevin/Archive/old-portfolio', 40],
].map(([name, path, daysAgo]) => {
  const date = new Date(Date.now() - (daysAgo as number) * DAY).toISOString()
  return {
    id: name as string,
    name: name as string,
    path: path as string,
    lastOpened: date,
    created: date,
  }
})

// The dialog reads the registry and checks each folder, as in the app. Here
// both are stand-ins, and the archived folder is gone. Module level, like
// GitSection's query cache setup
if (new URLSearchParams(window.location.search).get('section') === 'projects') {
  projectRegistryManager.getRegistry = () => ({
    projects: Object.fromEntries(PROJECTS.map(p => [p.id, p])),
    lastOpenedProject: PROJECTS[0]!.id,
    version: 2,
  })
  commands.folderStates = paths =>
    Promise.resolve(
      paths.map(path => (path.includes('/Archive/') ? 'missing' : 'present'))
    )
  useProjectStore.setState({ projectPath: PROJECTS[0]!.path })
  useProjectsScreenStore.setState({ isOpen: true })
}

/** The Projects screen, with one project whose folder is gone. */
export function ProjectsSection() {
  return <ProjectsDialog />
}
