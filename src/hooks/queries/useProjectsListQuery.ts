import { useQuery } from '@tanstack/react-query'
import { projectRegistryManager } from '@/lib/project-registry'
import type { ProjectMetadata } from '@/lib/project-registry/types'
import { foldersExist } from '@/lib/project-registry/utils'
import { queryKeys } from '@/lib/query-keys'

export interface ListedProject extends ProjectMetadata {
  /** False when the project's folder has been moved or deleted */
  folderExists: boolean
}

/**
 * Every project in the registry, and whether each one's folder is still
 * there. The folders are only checked while the Projects screen is open
 */
async function fetchProjects(): Promise<ListedProject[]> {
  const projects = registeredProjects()
  const exists = await foldersExist(projects.map(p => p.path))
  return projects.map((project, index) => ({
    ...project,
    folderExists: exists[index] ?? false,
  }))
}

export const useProjectsListQuery = (enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.projectsList,
    queryFn: fetchProjects,
    enabled,
    staleTime: 0,
  })

/** None until the registry has loaded, which refreshes the list */
function registeredProjects(): ProjectMetadata[] {
  try {
    return Object.values(projectRegistryManager.getRegistry().projects)
  } catch {
    return []
  }
}
