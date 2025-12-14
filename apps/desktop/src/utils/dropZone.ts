/**
 * Drop Zone Utilities
 *
 * Helper functions for calculating drop zones during drag-and-drop operations
 */

export type DropZone = 'top' | 'bottom' | 'left' | 'right' | null;

/**
 * Calculate which drop zone the mouse is in based on its position within a rectangle
 * @param mouseX - Mouse X position relative to the element
 * @param mouseY - Mouse Y position relative to the element
 * @param width - Width of the element
 * @param height - Height of the element
 * @returns The drop zone ('top', 'bottom', 'left', 'right') or null
 */
export function calculateDropZone(
  mouseX: number,
  mouseY: number,
  width: number,
  height: number
): DropZone {
  // Calculate distance to each edge
  const distToTop = mouseY;
  const distToBottom = height - mouseY;
  const distToLeft = mouseX;
  const distToRight = width - mouseX;

  // Find closest edge
  const minDist = Math.min(distToTop, distToBottom, distToLeft, distToRight);

  // Return the zone corresponding to the closest edge
  if (minDist === distToTop) return 'top';
  if (minDist === distToBottom) return 'bottom';
  if (minDist === distToLeft) return 'left';
  if (minDist === distToRight) return 'right';

  return null;
}
