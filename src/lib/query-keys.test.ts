import { describe, expect, it } from 'vitest'
import { queryKeys } from './query-keys'

describe('git query keys', () => {
  const project = '/sites/kr'

  it('nests every git key under the project, so one prefix refreshes them all', () => {
    const prefix = queryKeys.git(project)
    expect(prefix).toEqual(['project', project, 'git'])
    for (const key of [
      queryKeys.gitStatus(project),
      queryKeys.gitBranches(project),
      queryKeys.gitLog(project, 300),
      queryKeys.gitFileDiff(project, 'src/content/a.md'),
      queryKeys.gitCommitDetails(project, 'abc123'),
      queryKeys.gitCommitFileDiff(project, 'abc123', 'src/content/a.md'),
      queryKeys.githubRepoInfo(project),
      queryKeys.pullRequests(project),
    ]) {
      expect(key.slice(0, prefix.length)).toEqual(prefix)
    }
  })

  it('keeps keys for different files and commits apart', () => {
    expect(queryKeys.gitFileDiff(project, 'a.md')).not.toEqual(
      queryKeys.gitFileDiff(project, 'b.md')
    )
    expect(queryKeys.gitCommitFileDiff(project, 'one', 'a.md')).not.toEqual(
      queryKeys.gitCommitFileDiff(project, 'two', 'a.md')
    )
    expect(queryKeys.gitLog(project, 100)).not.toEqual(
      queryKeys.gitLog(project, 300)
    )
  })

  it("doesn't match the file watcher's refresh of directory and file lists", () => {
    // useFileChangeHandler invalidates keys with 'directory' at [3] or
    // 'files' at [4]; git keys must never look like those
    for (const key of [
      queryKeys.gitStatus(project),
      queryKeys.gitFileDiff(project, 'files'),
      queryKeys.gitCommitFileDiff(project, 'files', 'files'),
    ]) {
      expect(key[3]).not.toBe('directory')
      expect(key[4]).not.toBe('files')
    }
  })

  it('keeps GitHub sign-in outside any project', () => {
    expect(queryKeys.githubAuth[0]).not.toBe('project')
    expect(queryKeys.githubRepos[0]).not.toBe('project')
  })
})
