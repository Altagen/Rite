/**
 * Global toggle for the Settings modal. The modal itself is rendered once by an always-mounted
 * host (Workspace in local mode; AccountsShell in a server session, so it's reachable from the
 * overlay pages too — Teams / Collections / Notifications / Administration — via the identity
 * pastille). Any surface opens it with `setOpen(true)`.
 */
import { create } from 'zustand';

export const useSettingsModal = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
