// src/lib/query-keys.ts

export const queryKeys = {
  all: ['project'] as const,
  collections: (projectPath: string) =>
    [...queryKeys.all, projectPath, 'collections'] as const,
  // Every file in a collection, with its frontmatter, for entry pickers
  collectionFiles: (projectPath: string, collectionName: string) =>
    [...queryKeys.collections(projectPath), collectionName, 'files'] as const,
  // The files and folders in one folder of a collection, for the sidebar
  directoryContents: (
    projectPath: string,
    collectionName: string,
    subdirectory: string // 'root' or relative path like "2024/january"
  ) =>
    [
      ...queryKeys.all,
      projectPath,
      collectionName,
      'directory',
      subdirectory,
    ] as const,
  fileContent: (projectPath: string, fileId: string) =>
    [...queryKeys.all, projectPath, 'files', fileId] as const,
  mdxComponents: (projectPath: string, mdxDirectory?: string) =>
    [
      ...queryKeys.all,
      projectPath,
      'mdxComponents',
      mdxDirectory || 'default',
    ] as const,
  fileBasedCollection: (projectPath: string, collectionName: string) =>
    [
      ...queryKeys.all,
      projectPath,
      'fileBasedCollection',
      collectionName,
    ] as const,
  projectDependencies: (projectPath: string) =>
    [...queryKeys.all, projectPath, 'dependencies'] as const,
  // A loadable URL for an image path as written in a file. Relative paths
  // depend on the file, so it's part of the key
  imageSrc: (projectPath: string, filePath: string | null, imagePath: string) =>
    [...queryKeys.all, projectPath, 'imageSrc', filePath, imagePath] as const,
  // Git: everything under one prefix, so a commit, sync or checkout refreshes
  // status, branches, history and diffs together. Index 4 is never a path or
  // id, so useFileChangeHandler's predicate ('files' at [4]) can't match one
  git: (projectPath: string) => [...queryKeys.all, projectPath, 'git'] as const,
  gitStatus: (projectPath: string) =>
    [...queryKeys.git(projectPath), 'status'] as const,
  gitBranches: (projectPath: string) =>
    [...queryKeys.git(projectPath), 'branches'] as const,
  // Commits the default branch has that the current one doesn't
  gitBehindDefault: (projectPath: string) =>
    [...queryKeys.git(projectPath), 'behindDefault'] as const,
  gitLog: (projectPath: string, limit: number) =>
    [...queryKeys.git(projectPath), 'log', limit] as const,
  // Working tree vs HEAD for one file
  gitFileDiff: (projectPath: string, path: string) =>
    [...queryKeys.git(projectPath), 'diff', 'workingTree', path] as const,
  gitCommitDetails: (projectPath: string, id: string) =>
    [...queryKeys.git(projectPath), 'commit', 'details', id] as const,
  gitCommitFileDiff: (projectPath: string, id: string, path: string) =>
    [...queryKeys.git(projectPath), 'commit', 'diff', id, path] as const,
  githubRepoInfo: (projectPath: string) =>
    [...queryKeys.git(projectPath), 'repoInfo'] as const,
  pullRequests: (projectPath: string) =>
    [...queryKeys.git(projectPath), 'pullRequests'] as const,
  // Not tied to a project
  appVersion: ['appVersion'] as const,
  githubAuth: ['githubAuth'] as const,
  githubRepos: ['githubRepos'] as const,
  // Add more keys here as needed
}
