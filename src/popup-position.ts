export const enum PopupPositionMode {
  Start,
  TopLeft = Start,
  Auto,
  BottomRight,
  End = BottomRight,
}

// Minimum space to leave between the edge of the pop-up and the edge of the
// window.
const GUTTER = 5;

export function getPopupPosition({
  doc,
  mousePos,
  popupSize,
  positionMode,
  targetElem,
}: {
  doc: Document;
  mousePos: { x: number; y: number } | null;
  popupSize: { width: number; height: number };
  positionMode: PopupPositionMode;
  targetElem: Element | null;
}): {
  x: number;
  y: number;
  constrainWidth: number | null;
  constrainHeight: number | null;
} {
  const { scrollX, scrollY } = doc.defaultView!;
  // Use the clientWidth (as opposed to doc.defaultView.innerWidth) since this
  // excludes the width of any scrollbars.
  const windowWidth = doc.documentElement.clientWidth;
  // For the height, however, we need to be careful because in quirks mode the
  // body has the viewport height.
  const windowHeight =
    doc.compatMode === 'BackCompat'
      ? doc.body?.clientHeight || doc.defaultView!.innerHeight
      : doc.documentElement.clientHeight;

  if (positionMode === PopupPositionMode.Auto) {
    return getAutoPosition({
      doc,
      mousePos,
      popupSize,
      scrollX,
      scrollY,
      targetElem,
      windowWidth,
      windowHeight,
    });
  }

  const availableWindowHeight = windowHeight - 2 * GUTTER;

  const left = scrollX + GUTTER;
  const top = scrollY + GUTTER;
  const right = scrollX + windowWidth - popupSize.width - GUTTER;
  const bottom =
    scrollY +
    windowHeight -
    Math.min(popupSize.height, availableWindowHeight) -
    GUTTER;

  // We could calculate a value for constrainHeight as something like:
  //
  //   constrainHeight = popupSize.height > availableWindowHeight
  //                     ? availableWindowHeight
  //                     : null;
  //
  // and we'd get the nice fade effect to show in that case, but it's probably
  // more useful to NOT constrain it and let the user scroll if the content
  // overflows the viewport.

  switch (positionMode) {
    case PopupPositionMode.TopLeft:
      return {
        x: left,
        y: top,
        constrainWidth: null,
        constrainHeight: null,
      };

    case PopupPositionMode.BottomRight:
      return {
        x: right,
        y: bottom,
        constrainWidth: null,
        constrainHeight: null,
      };
  }
}

function getAutoPosition({
  doc,
  mousePos,
  popupSize,
  scrollX,
  scrollY,
  targetElem,
  windowWidth,
  windowHeight,
}: {
  doc: Document;
  mousePos: { x: number; y: number } | null;
  popupSize: { width: number; height: number };
  scrollX: number;
  scrollY: number;
  targetElem: Element | null;
  windowWidth: number;
  windowHeight: number;
}): {
  x: number;
  y: number;
  constrainWidth: number | null;
  constrainHeight: number | null;
} {
  let x = mousePos?.x || 0;
  let y = mousePos?.y || 0;

  if (!targetElem) {
    return { x, y, constrainWidth: null, constrainHeight: null };
  }

  // Check for vertical text
  const isVerticalText =
    targetElem &&
    doc
      .defaultView!.getComputedStyle(targetElem)
      .writingMode.startsWith('vertical');

  // Inline position: Go back (left or up) if necessary
  //
  // (We shouldn't need to check the opposite direction since the initial
  // position, if set to something non-zero, is coming from a mouse event which
  // should, I believe, be positive.)
  let inline = isVerticalText ? y : x;
  const inlinePopupSize = isVerticalText ? popupSize.height : popupSize.width;
  const inlineWindowSize = isVerticalText ? windowHeight : windowWidth;
  if (inline + inlinePopupSize > inlineWindowSize - GUTTER) {
    inline = inlineWindowSize - inlinePopupSize - GUTTER;
    if (inline < 0) {
      inline = 0;
    }
  }

  // Block position: Position "below" the mouse cursor
  let blockAdjust = 25;

  // If the element has a title, then there will probably be
  // a tooltip that we shouldn't cover up.
  if ((targetElem as HTMLElement).title) {
    blockAdjust += 20;
  }

  // Check if we are too close to the window edge (bottom / right)...
  let block = isVerticalText ? x : y;
  const blockPopupSize = isVerticalText ? popupSize.width : popupSize.height;
  const blockWindowSize = isVerticalText ? windowWidth : windowHeight;
  let constrainBlockSize: number | null = null;
  if (block + blockAdjust + blockPopupSize > blockWindowSize) {
    // ...we are. See if the other side has more room.
    const spaceOnThisSide = blockWindowSize - block;
    const spaceOnOtherSide = block;
    if (spaceOnOtherSide > spaceOnThisSide) {
      blockAdjust = Math.max(-blockPopupSize - 25, -block);
      if (spaceOnOtherSide - 25 < blockPopupSize) {
        constrainBlockSize = spaceOnOtherSide - 25;
      }
    }
  }

  block += blockAdjust;

  // De-logicalize before we add the scroll position since that's phyiscal
  x = isVerticalText ? block : inline;
  y = isVerticalText ? inline : block;
  const constrainHeight = !isVerticalText ? constrainBlockSize : null;
  const constrainWidth = isVerticalText ? constrainBlockSize : null;

  // Adjust for scroll position
  x += scrollX;
  y += scrollY;

  return { x, y, constrainWidth, constrainHeight };
}
