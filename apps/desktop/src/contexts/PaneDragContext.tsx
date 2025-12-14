/**
 * Pane Drag Context
 *
 * Manages drag & drop state for pane reorganization within a tab
 */

import { createContext, useContext, useState, ReactNode } from 'react';

type DropPosition = 'top' | 'bottom' | 'left' | 'right';

interface PaneDragContextType {
  draggedPaneId: string | null;
  dropTargetPaneId: string | null;
  dropPosition: DropPosition | null;
  setDraggedPane: (paneId: string | null) => void;
  setDropTarget: (paneId: string | null, position: DropPosition | null) => void;
}

const PaneDragContext = createContext<PaneDragContextType | undefined>(undefined);

export function PaneDragProvider({ children }: { children: ReactNode }) {
  const [draggedPaneId, setDraggedPaneId] = useState<string | null>(null);
  const [dropTargetPaneId, setDropTargetPaneId] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<DropPosition | null>(null);

  const setDraggedPane = (paneId: string | null) => {
    setDraggedPaneId(paneId);
    if (!paneId) {
      // Reset drop target when drag ends
      setDropTargetPaneId(null);
      setDropPosition(null);
    }
  };

  const setDropTarget = (paneId: string | null, position: DropPosition | null) => {
    setDropTargetPaneId(paneId);
    setDropPosition(position);
  };

  return (
    <PaneDragContext.Provider
      value={{
        draggedPaneId,
        dropTargetPaneId,
        dropPosition,
        setDraggedPane,
        setDropTarget,
      }}
    >
      {children}
    </PaneDragContext.Provider>
  );
}

export function usePaneDrag() {
  const context = useContext(PaneDragContext);
  if (!context) {
    throw new Error('usePaneDrag must be used within PaneDragProvider');
  }
  return context;
}
