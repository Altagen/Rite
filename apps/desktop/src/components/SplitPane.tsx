/**
 * SplitPane Component
 *
 * Renders a resizable split container with two children and a divider
 */

import { useRef, useState, useEffect, ReactNode } from 'react';

export interface SplitPaneProps {
  direction: 'horizontal' | 'vertical';
  ratio: number; // 0.0 to 1.0
  onRatioChange: (newRatio: number) => void;
  left: ReactNode;
  right: ReactNode;
  className?: string;
}

export function SplitPane({ direction, ratio, onRatioChange, left, right, className = '' }: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isHovering, setIsHovering] = useState(false);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;

      const bounds = containerRef.current.getBoundingClientRect();

      let newRatio: number;
      if (direction === 'horizontal') {
        const x = e.clientX - bounds.left;
        newRatio = x / bounds.width;
      } else {
        const y = e.clientY - bounds.top;
        newRatio = y / bounds.height;
      }

      // Clamp ratio between 0.1 and 0.9 (10% minimum pane size)
      newRatio = Math.max(0.1, Math.min(0.9, newRatio));
      onRatioChange(newRatio);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, direction, onRatioChange]);

  const handleDividerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const isHorizontal = direction === 'horizontal';
  const firstSize = `${ratio * 100}%`;
  const secondSize = `${(1 - ratio) * 100}%`;

  return (
    <div
      ref={containerRef}
      className={`flex ${isHorizontal ? 'flex-row' : 'flex-col'} w-full h-full ${className}`}
      style={{
        cursor: (isDragging || isHovering) ? (isHorizontal ? 'col-resize' : 'row-resize') : undefined,
      }}
    >
      {/* First pane */}
      <div
        className="overflow-hidden"
        style={{
          [isHorizontal ? 'width' : 'height']: firstSize,
          minWidth: isHorizontal ? '10%' : undefined,
          minHeight: !isHorizontal ? '10%' : undefined,
        }}
      >
        {left}
      </div>

      {/* Resizable divider with larger hit area */}
      <div
        className={`
          relative flex-shrink-0 cursor-${isHorizontal ? 'col' : 'row'}-resize
          ${isHorizontal ? 'w-1' : 'h-1'}
        `}
        onMouseDown={handleDividerMouseDown}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
        style={{
          userSelect: 'none',
        }}
      >
        {/* Visual divider with enhanced hover effect */}
        <div
          className={`
            absolute inset-0 transition-all duration-200
            ${isDragging ? 'bg-primary shadow-lg' : ''}
            ${isHovering && !isDragging ? 'bg-primary/60' : ''}
            ${!isHovering && !isDragging ? 'bg-border' : ''}
          `}
        />
        {/* Larger invisible hit area for easier grabbing */}
        <div
          className={`
            absolute
            ${isHorizontal ? 'w-3 h-full -left-1' : 'h-3 w-full -top-1'}
          `}
          style={{ userSelect: 'none' }}
        />
      </div>

      {/* Second pane */}
      <div
        className="overflow-hidden"
        style={{
          [isHorizontal ? 'width' : 'height']: secondSize,
          minWidth: isHorizontal ? '10%' : undefined,
          minHeight: !isHorizontal ? '10%' : undefined,
        }}
      >
        {right}
      </div>
    </div>
  );
}
