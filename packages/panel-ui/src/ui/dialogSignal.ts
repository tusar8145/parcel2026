/** Told when a dialog opens: a button whose work opened a dialog stops showing busy (the dialog is the next step). */
const listeners = new Set<() => void>();
export const onDialogOpen = (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener));
export const dialogOpened = () => listeners.forEach(l => l());
