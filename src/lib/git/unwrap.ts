type CommandResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'error'; error: string }

/**
 * The data of a command's result, or an Error with its message. Git and
 * GitHub commands return plain-language messages, so they can be shown as is.
 */
export async function unwrap<T>(result: Promise<CommandResult<T>>): Promise<T> {
  const settled = await result
  if (settled.status === 'error') throw new Error(settled.error)
  return settled.data
}
