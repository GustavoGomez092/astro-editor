import { create } from 'zustand'

/** Whether the Projects screen (the list of projects opened before) shows */
interface ProjectsScreenState {
  isOpen: boolean
  open: () => void
  close: () => void
}

export const useProjectsScreenStore = create<ProjectsScreenState>(set => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}))
