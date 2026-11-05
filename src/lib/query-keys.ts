// src/lib/query-keys.ts

export const queryKeys = {
  all: ['project'] as const,
  // The Projects screen's list. Not under `all`, which the file watcher
  // refreshes, since it checks every project's folder
  projectsList: ['projectsList'] as const,
  // A site's picture on Home and in the switcher. Not under `all`: it belongs
  // to a site whether or not that site is open
  projectPreview: (projectPath: string) =>
    ['projectPreview', projectPath] as const,
  collections: (projectPath: string) =>
    [...queryKeys.all, projectPath, 'collections'] as const,
  // Every file in a collection, with its frontmatter, for entry pickers
  // The queries that read a collection's folder end with it, so a folder
  // changing (a folder set in Collection Settings) is a new query. Leave it
  // out to refresh the collection's queries whatever its folder
  collectionFiles: (
    projectPath: string,
    collectionName: string,
    collectionPath?: string
  ) =>
    [
      ...queryKeys.collections(projectPath),
      collectionName,
      'files',
      ...(collectionPath ? [collectionPath] : []),
    ] as const,
  // Whether any entry has body text. Under collectionFiles, so whatever
  // refreshes the collection's files refreshes it too
  collectionHasBody: (projectPath: string, collectionName: string) =>
    [
      ...queryKeys.collectionFiles(projectPath, collectionName),
      'hasBody',
    ] as const,
  // How many files a collection holds, subfolders included, for the sidebar.
  // Not under collectionFiles: saves refresh that after every frontmatter
  // edit, and counting walks the whole folder. Refreshed by name instead (the
  // watcher for files added or removed, creating an entry), by
  // reloadProjectFiles, and by Reload Collections with everything else
  collectionFileCount: (
    projectPath: string,
    collectionName: string,
    collectionPath?: string
  ) =>
    [
      ...queryKeys.all,
      projectPath,
      'fileCount',
      collectionName,
      ...(collectionPath ? [collectionPath] : []),
    ] as const,
  // The files and folders in one folder of a collection, for the sidebar
  directoryContents: (
    projectPath: string,
    collectionName: string,
    subdirectory: string, // 'root' or relative path like "2024/january"
    collectionPath?: string
  ) =>
    [
      ...queryKeys.all,
      projectPath,
      collectionName,
      'directory',
      subdirectory,
      ...(collectionPath ? [collectionPath] : []),
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
  // The project's dev server, refetched on every `dev-server-state` event
  devServer: (projectPath: string) =>
    [...queryKeys.all, projectPath, 'devServer'] as const,
  devServerLogs: (projectPath: string) =>
    [...queryKeys.devServer(projectPath), 'logs'] as const,
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
  // Commits the current branch has that the default one doesn't
  gitAheadOfDefault: (projectPath: string) =>
    [...queryKeys.git(projectPath), 'aheadOfDefault'] as const,
  gitLog: (projectPath: string, limit: number) =>
    [...queryKeys.git(projectPath), 'log', limit] as const,
  // Files that conflict between the branch and its upstream
  gitConflicts: (projectPath: string) =>
    [...queryKeys.git(projectPath), 'conflicts'] as const,
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
