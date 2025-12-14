/**
 * PaneContainer Component
 *
 * Recursive component that renders the pane tree structure
 */

import { useRef, useEffect } from 'react';
import { AnyPaneNode } from '../types/pane';
import { SplitPane } from './SplitPane';
import { Terminal } from './Terminal';
import { usePaneDrag } from '../contexts/PaneDragContext';
import { calculateDropZone } from '../utils/dropZone';

export interface PaneContainerProps {
  node: AnyPaneNode;
  onSplitRatioChange: (splitId: string, newRatio: number) => void;
  onClosePane: (paneId: string) => void;
  onFocusPane: (paneId: string) => void;
  onSplitPane: (paneId: string, direction: 'horizontal' | 'vertical') => void;
  onDetachPane?: (paneId: string) => void;
  onReorganizePane?: (sourcePaneId: string, targetPaneId: string, position: 'top' | 'bottom' | 'left' | 'right') => void;
}

export function PaneContainer({ node, onSplitRatioChange, onClosePane, onFocusPane, onSplitPane, onDetachPane, onReorganizePane }: PaneContainerProps) {
  const { draggedPaneId, setDraggedPane, dropTargetPaneId, dropPosition, setDropTarget } = usePaneDrag();
  const paneRef = useRef<HTMLDivElement>(null);

  // Global dragover handler to detect which pane we're over
  useEffect(() => {
    // ONLY activate when a PANE is being dragged (not a tab)
    if (!draggedPaneId || node.type !== 'terminal') return;

    const handleGlobalDragOver = (e: DragEvent) => {
      // Only handle if we're dragging a pane (not a tab)
      const dragType = e.dataTransfer?.types;
      if (!dragType || !dragType.includes('application/x-rite-pane')) return;
      // Ignore tab drags
      if (dragType.includes('application/x-rite-tab')) return;

      e.preventDefault(); // CRITICAL: allow drop
      e.stopPropagation();

      if (!paneRef.current || draggedPaneId === node.id) return;

      // Check if mouse is over this pane
      const rect = paneRef.current.getBoundingClientRect();
      const x = e.clientX;
      const y = e.clientY;

      const isOver = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

      if (isOver) {
        e.dataTransfer!.dropEffect = 'move';

        // Calculate drop zone using utility function
        const relX = x - rect.left;
        const relY = y - rect.top;
        const zone = calculateDropZone(relX, relY, rect.width, rect.height);

        setDropTarget(node.id, zone);
      }
    };

    document.addEventListener('dragover', handleGlobalDragOver);
    return () => document.removeEventListener('dragover', handleGlobalDragOver);
  }, [draggedPaneId, node]);

  if (node.type === 'terminal') {
    const isDragging = draggedPaneId === node.id;
    const isDropTarget = dropTargetPaneId === node.id;

    // Calculate which drop zone the mouse is in
    const handleDragOver = (e: React.DragEvent) => {
      // Ignore tab drags - only handle pane drags
      if (e.dataTransfer.types.includes('application/x-rite-tab')) {
        return; // Let TerminalManager handle tab drops
      }

      e.preventDefault();
      e.stopPropagation();

      if (!draggedPaneId || draggedPaneId === node.id || !paneRef.current) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }

      e.dataTransfer.dropEffect = 'move';

      const rect = paneRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Calculate drop zone using utility function
      const zone = calculateDropZone(x, y, rect.width, rect.height);

      setDropTarget(node.id, zone);
    };

    const handleDragLeave = (e: React.DragEvent) => {
      // Only clear drop target if we're actually leaving this pane's boundary
      const relatedTarget = e.relatedTarget as HTMLElement;
      if (paneRef.current && !paneRef.current.contains(relatedTarget)) {
        if (dropTargetPaneId === node.id) {
          setDropTarget(null, null);
        }
      }
    };

    const handleDrop = (e: React.DragEvent) => {
      // Ignore tab drags - only handle pane drags
      if (e.dataTransfer.types.includes('application/x-rite-tab')) {
        return; // Let TerminalManager handle tab drops
      }

      e.preventDefault();
      e.stopPropagation();

      if (draggedPaneId && dropPosition && onReorganizePane) {
        onReorganizePane(draggedPaneId, node.id, dropPosition);
      }

      setDropTarget(null, null);
      setDraggedPane(null);
    };

    const handleDragStart = (e: React.DragEvent) => {
      e.stopPropagation();

      // Create a drag image to ensure drag works properly
      const dragImage = document.createElement('div');
      dragImage.style.width = '100px';
      dragImage.style.height = '100px';
      dragImage.style.backgroundColor = 'transparent';
      dragImage.style.position = 'absolute';
      dragImage.style.top = '-1000px';
      document.body.appendChild(dragImage);

      e.dataTransfer.setDragImage(dragImage, 0, 0);
      setTimeout(() => document.body.removeChild(dragImage), 0);

      setDraggedPane(node.id);
      e.dataTransfer.effectAllowed = 'move';
      // Use a custom MIME type to distinguish pane drags from tab drags
      e.dataTransfer.setData('application/x-rite-pane', node.id);
    };

    const handleDragEnd = () => {
      setDraggedPane(null);
      setDropTarget(null, null);
    };

    // Terminal leaf node - render the actual terminal with drag & drop
    return (
      <div
        ref={paneRef}
        className={`flex flex-1 w-full h-full relative ${node.isFocused ? 'ring-2 ring-primary ring-inset' : ''} ${isDragging ? 'opacity-50' : ''}`}
        onClick={() => onFocusPane(node.id)}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          pointerEvents: draggedPaneId && draggedPaneId !== node.id ? 'auto' : undefined,
        }}
      >
        <Terminal
          key={node.session.id}
          connectionId={node.session.connectionId}
          connectionName={node.session.connectionName}
          sessionId={node.session.id}
          isFocused={node.isFocused}
          onClose={() => onClosePane(node.id)}
          onSplitHorizontal={() => onSplitPane(node.id, 'horizontal')}
          onSplitVertical={() => onSplitPane(node.id, 'vertical')}
          onDetach={onDetachPane ? () => onDetachPane(node.id) : undefined}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          isDragging={!!draggedPaneId}
        />

        {/* Drop zone indicators */}
        {isDropTarget && dropPosition && (
          <>
            {/* Visual highlight for the drop zone */}
            <div
              className={`absolute pointer-events-none bg-primary/20 border-2 border-primary transition-all ${
                dropPosition === 'top' ? 'top-0 left-0 right-0 h-1/2' :
                dropPosition === 'bottom' ? 'bottom-0 left-0 right-0 h-1/2' :
                dropPosition === 'left' ? 'left-0 top-0 bottom-0 w-1/2' :
                'right-0 top-0 bottom-0 w-1/2'
              }`}
            />
            {/* Label indicator */}
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
              <div className="bg-card border-2 border-primary rounded-lg px-4 py-2 shadow-2xl">
                <div className="flex items-center gap-2">
                  <svg className="h-5 w-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
                  </svg>
                  <span className="text-sm font-medium text-primary">Drop {dropPosition}</span>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  if (node.type === 'split') {
    // Split container node - recursively render children
    return (
      <SplitPane
        direction={node.direction}
        ratio={node.ratio}
        onRatioChange={(newRatio) => onSplitRatioChange(node.id, newRatio)}
        left={
          <PaneContainer
            node={node.children[0]}
            onSplitRatioChange={onSplitRatioChange}
            onClosePane={onClosePane}
            onFocusPane={onFocusPane}
            onSplitPane={onSplitPane}
            onDetachPane={onDetachPane}
            onReorganizePane={onReorganizePane}
          />
        }
        right={
          <PaneContainer
            node={node.children[1]}
            onSplitRatioChange={onSplitRatioChange}
            onClosePane={onClosePane}
            onFocusPane={onFocusPane}
            onSplitPane={onSplitPane}
            onDetachPane={onDetachPane}
            onReorganizePane={onReorganizePane}
          />
        }
      />
    );
  }

  // Should never reach here
  return null;
}
