import { useState } from 'react'
import { useUIStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { useCreateFile } from '../../hooks/useCreateFile'
import { newFileTitlePlaceholder } from '../../lib/files/new-file'
import { getDefaultFileType } from '../../lib/project-registry/default-file-type'
import { slugFromTitle } from '../../lib/slug'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { Field, FieldDescription, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { Button } from '../ui/button'

/**
 * Asks for a new entry's title before creating it, so the file is named after
 * the title rather than today's date. Opened by `useCreateFile().createNewFile`.
 */
export function NewFileDialog() {
  const open = useUIStore(state => state.newFileDialogOpen)
  const selectedCollection = useProjectStore(state => state.selectedCollection)
  const globalSettings = useProjectStore(state => state.globalSettings)
  const projectSettings = useProjectStore(state => state.currentProjectSettings)
  const { createNamedFile } = useCreateFile()
  const [title, setTitle] = useState('')

  const placeholder = selectedCollection
    ? newFileTitlePlaceholder(selectedCollection)
    : 'New entry'
  const extension = getDefaultFileType(
    globalSettings,
    projectSettings,
    selectedCollection ?? undefined
  )
  const slug = slugFromTitle(title)

  const close = () => {
    useUIStore.getState().setNewFileDialogOpen(false)
    setTitle('')
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const name = title
    close()
    void createNamedFile(name)
  }

  return (
    <Dialog open={open} onOpenChange={isOpen => !isOpen && close()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{placeholder}</DialogTitle>
            <DialogDescription>
              The file is named after the title.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="new-file-title">Title</FieldLabel>
            <Input
              id="new-file-title"
              value={title}
              placeholder={placeholder}
              onChange={event => setTitle(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <FieldDescription>
              {slug
                ? `${slug}.${extension}`
                : "Without a title, it's named for today's date."}
            </FieldDescription>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit">Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
