/**
 * Where a floating menu goes, so that all of it is on screen.
 *
 * Every popup in this app was positioned the same way — `rect.bottom + 4`, with at
 * best a clamp on the left — and nothing anywhere consulted `window.innerHeight`.
 * That works for as long as every button lives in the header or the tab strip, which
 * was true until the Layouts button was added to the empty state, where it sits in
 * the middle of the screen: the menu then started below mid-height, ran past the
 * bottom edge, and its own `overflow-auto` scrolled a region that was itself below
 * the fold. The last layouts in the list were unreachable.
 *
 * So the rule lives here once, rather than being fixed in the one menu that exposed
 * it. Given where the button is, how big the menu wants to be, and how big the
 * viewport is, this answers with a box that fits: below the button when there is
 * room, above it when there is more room there, and never taller than the space it
 * was given. The caller applies `maxHeight` and keeps its own `overflow-auto`, so a
 * list longer than the screen scrolls inside a box that is fully visible.
 *
 * Imports nothing — not even the DOM types it describes — so the standalone check can
 * load it and hold the contract: the returned box is inside the viewport.
 */

/** The button the menu hangs off, in viewport coordinates (a DOMRect fits this). */
export interface MenuAnchor {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** How big the menu would like to be, in CSS pixels. */
export interface MenuSize {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface MenuPlacement {
  top: number;
  left: number;
  /** Apply as `max-height`: the menu may be shorter, never taller. */
  maxHeight: number;
}

/** Breathing room kept between the menu and every edge of the viewport. */
const MARGIN = 8;

/**
 * Place `size` against `anchor` inside `viewport`.
 *
 * Vertically: below the anchor when the menu fits there; otherwise whichever side has
 * more room, with the height cut to that room. Preferring "fits below" over "most
 * room" matters — a menu that fits below should not jump above just because the
 * button sits low on a tall screen.
 *
 * Horizontally: right-aligned with the anchor, which is what a right-hand toolbar
 * button wants, then pulled back inside both edges.
 */
export function placeMenu(
  anchor: MenuAnchor,
  size: MenuSize,
  viewport: Viewport,
  gap = 4,
): MenuPlacement {
  // Either room may come out negative, for a button scrolled outside the viewport.
  // That needs no special case: a negative room loses the comparison below, and the
  // two clamps at the end are what actually keep the box on screen.
  const roomBelow = viewport.height - anchor.bottom - gap - MARGIN;
  const roomAbove = anchor.top - gap - MARGIN;
  const below = size.height <= roomBelow || roomBelow >= roomAbove;

  const room = below ? roomBelow : roomAbove;
  const wanted = Math.min(size.height, room);
  const top = Math.max(MARGIN, below ? anchor.bottom + gap : anchor.top - gap - wanted);
  // Clamped after `top` is final: a degenerate anchor (flush against the top edge,
  // a zero-height viewport) must not produce a box that hangs off the bottom.
  const maxHeight = Math.max(1, Math.min(wanted, viewport.height - top - MARGIN));

  const rightmost = Math.max(MARGIN, viewport.width - size.width - MARGIN);
  const left = Math.min(rightmost, Math.max(MARGIN, anchor.right - size.width));

  return { top, left, maxHeight };
}
