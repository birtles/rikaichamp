/*

  10ten Japanese Reader
  by Brian Birtles
  https://github.com/birchill/10ten-ja-reader

  ---

  Originally based on Rikaikun
  by Erek Speed
  http://code.google.com/p/rikaikun/

  ---

  Originally based on Rikaichan 1.07
  by Jonathan Zarate
  http://www.polarcloud.com/

  ---

  Originally based on RikaiXUL 0.4 by Todd Rudick
  http://www.rikai.com/
  http://rikaixul.mozdev.org/

  ---

  This program is free software; you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation; either version 2 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program; if not, write to the Free Software
  Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA

  ---

  Please do not change or remove any of the copyrights or links to web pages
  when modifying any of the files. - Jon

*/

import type { MajorDataSeries } from '@birchill/hikibiki-data';
import Browser, { browser } from 'webextension-polyfill-ts';

import { ContentConfig } from './content-config';
import { CopyKeys, CopyType } from './copy-keys';
import {
  getEntryToCopy,
  getFieldsToCopy,
  getWordToCopy,
  Entry as CopyEntry,
} from './copy-text';
import {
  isContentEditableNode,
  isEditableNode,
  isFocusable,
  isTextInputNode,
} from './dom-utils';
import { getTextAtPoint, GetTextAtPointResult } from './get-text';
import { SelectionMeta } from './meta';
import { mod } from './mod';
import {
  CopyState,
  hidePopup,
  isPopupVisible,
  isPopupWindow,
  PopupOptions,
  removePopup,
  renderPopup,
  setPopupStyle,
} from './popup';
import { getPopupPosition, PopupPositionMode } from './popup-position';
import { RikaiPuck } from './puck';
import { query, QueryResult } from './query';
import { isForeignObjectElement, isSvgDoc, isSvgSvgElement } from './svg';
import { hasReasonableTimerResolution } from './timer-precision';

// Either end of a Range object
interface RangeEndpoint {
  container: Node;
  offset: number;
}

export interface GetTextResult {
  text: string;
  // Contains the node and offset where the selection starts. This will be null
  // if, for example, the result is the text from an element's title attribute.
  rangeStart: RangeEndpoint | null;
  // Contains the node and offset for each text-containing node in the
  // maximum selected range.
  rangeEnds: RangeEndpoint[];
  // Extra metadata we parsed in the process
  meta?: SelectionMeta;
}

export class ContentHandler {
  // This should be enough for most (but not all) entries for now.
  //
  // See https://github.com/birchill/10ten-ja-reader/issues/319#issuecomment-655545971
  // for a snapshot of the entry lengths by frequency.
  //
  // Once we have switched all databases to IndexedDB, we should investigate the
  // performance impact of increasing this further.
  private static MAX_LENGTH = 16;

  private config: ContentConfig;

  // Lookup tracking (so we can avoid redundant work and so we can re-render)
  private currentTextAtPoint: GetTextAtPointResult | null = null;
  private currentPoint: { x: number; y: number } | null = null;
  private currentSearchResult: QueryResult | null = null;
  private currentTarget: Element | null = null;
  private currentDict: MajorDataSeries = 'words';

  // Highlight tracking
  private selectedWindow: Window | null = null;
  private selectedText: string | null = null;
  private selectedTextBox: {
    node: HTMLInputElement | HTMLTextAreaElement;
    previousStart: number | null;
    previousEnd: number | null;
    previousDirection: 'forward' | 'backward' | 'none' | null;
  } | null = null;
  private previousFocus: Element | null;
  private previousSelection: { node: Node; offset: number } | null;
  private ignoreFocusEvent: boolean = false;

  // Mouse tracking
  //
  // We don't show the popup when the mouse is moving at speed because it's
  // mostly distracting and introduces unnecessary work.
  private static MOUSE_SPEED_SAMPLES = 2;
  private static MOUSE_SPEED_THRESHOLD = 0.5;
  private mouseSpeedRollingSum: number = 0;
  private mouseSpeeds: number[] = [];
  private previousMousePosition: { x: number; y: number } | null = null;
  private previousMouseMoveTime: number | null = null;
  // We disable this feature by default and only turn it on once we've
  // established that we have a sufficiently precise timer. If
  // privacy.resistFingerprinting is enabled then the timer won't be precise
  // enough for us to test the speed of the mouse.
  private hidePopupWhenMovingAtSpeed: boolean = false;

  // Keyboard support
  private kanjiLookupMode: boolean = false;

  // Used to try to detect when we are typing so we know when to ignore key
  // events.
  private typingMode: boolean = false;

  // Copy support
  private copyMode: boolean = false;
  private copyIndex: number = 0;

  // Manual positioning support
  private popupPositionMode: PopupPositionMode = PopupPositionMode.Auto;

  constructor(config: ContentConfig) {
    this.config = config;

    this.onMouseMove = this.onMouseMove.bind(this);
    this.onMouseDown = this.onMouseDown.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    this.onFocusIn = this.onFocusIn.bind(this);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('keydown', this.onKeyDown, { capture: true });
    window.addEventListener('keyup', this.onKeyUp, { capture: true });
    window.addEventListener('focusin', this.onFocusIn);

    hasReasonableTimerResolution().then((isReasonable) => {
      if (isReasonable) {
        this.hidePopupWhenMovingAtSpeed = true;
      }
    });
  }

  setConfig(config: Readonly<ContentConfig>) {
    // Update the style of the popup
    if (this.config && config.popupStyle !== this.config.popupStyle) {
      setPopupStyle(config.popupStyle);
    }

    // TODO: We should probably check which keys have changed and regenerate
    // the pop-up if needed but currently you need to change tabs to tweak
    // the config so the popup probably won't be showing anyway.
    this.config = { ...config };
  }

  detach() {
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('keydown', this.onKeyDown, { capture: true });
    window.removeEventListener('keyup', this.onKeyUp, { capture: true });
    window.removeEventListener('focusin', this.onFocusIn);

    this.clearHighlight(null);
    this.selectedTextBox = null;
    this.copyMode = false;

    removePopup();
  }

  onMouseMove(ev: MouseEvent) {
    this.typingMode = false;

    // Ignore mouse events while buttons are being pressed.
    if (ev.buttons) {
      return;
    }

    // Ignore mouse events on the popup window
    if (isPopupWindow(ev.target)) {
      return;
    }

    // Check if any required "hold to show keys" are held. We do this before
    // checking throttling since that can be expensive and when this is
    // configured, typically the user will have the extension more-or-less
    // permanently enabled so we don't want to add unnecessary latency to
    // regular mouse events.
    if (!this.areHoldToShowKeysDown(ev)) {
      this.clearHighlight(ev.target as Element);
      // Nevertheless, we still want to set the current position information so
      // that if the user presses the hold-to-show keys later we can show the
      // popup immediately.
      this.currentTarget = ev.target as Element;
      this.currentPoint = { x: ev.clientX, y: ev.clientY };
      return;
    }

    if (this.shouldThrottlePopup(ev)) {
      this.clearHighlight(ev.target as Element);
      return;
    }

    let dictMode: 'default' | 'kanji' = 'default';
    if (ev.shiftKey && this.config.keys.kanjiLookup.includes('Shift')) {
      this.kanjiLookupMode = ev.shiftKey;
      dictMode = 'kanji';
    }

    this.tryToUpdatePopup(
      { x: ev.clientX, y: ev.clientY },
      ev.target as Element,
      dictMode
    );
  }

  shouldThrottlePopup(ev: MouseEvent) {
    if (!this.hidePopupWhenMovingAtSpeed) {
      return false;
    }

    let averageSpeed = 0;

    if (this.previousMousePosition && this.previousMouseMoveTime) {
      // If the events are backed up their times might be equal. Likewise, if
      // the events are more than a couple of animation frames apart either the
      // mouse stopped, or the system is backed up and the OS can't even
      // dispatch the events.
      //
      // In either case we should:
      //
      // - Update the previous mouse position and time so that when we get the
      //   *next* event we can accurately measure the speed.
      //
      // - Not throttle the popup since for some content we might always be
      //   backed up (YouTube with browser console open seems particularly bad)
      //   and its safer to just allow the popup in this case rather than risk
      //   permanently hiding it.
      //
      if (
        ev.timeStamp === this.previousMouseMoveTime ||
        ev.timeStamp - this.previousMouseMoveTime > 32
      ) {
        this.previousMousePosition = { x: ev.pageX, y: ev.pageY };
        this.previousMouseMoveTime = ev.timeStamp;
        return false;
      }

      const distance = Math.sqrt(
        Math.pow(ev.pageX - this.previousMousePosition.x, 2) +
          Math.pow(ev.pageY - this.previousMousePosition.y, 2)
      );
      const speed = distance / (ev.timeStamp - this.previousMouseMoveTime);

      this.mouseSpeeds.push(speed);
      this.mouseSpeedRollingSum += speed;

      if (this.mouseSpeeds.length > ContentHandler.MOUSE_SPEED_SAMPLES) {
        this.mouseSpeedRollingSum -= this.mouseSpeeds.shift()!;
      }

      averageSpeed = this.mouseSpeedRollingSum / this.mouseSpeeds.length;
    }

    this.previousMousePosition = { x: ev.pageX, y: ev.pageY };
    this.previousMouseMoveTime = ev.timeStamp;

    return averageSpeed >= ContentHandler.MOUSE_SPEED_THRESHOLD;
  }

  onMouseDown(ev: MouseEvent) {
    // Ignore mouse events on the popup window
    if (isPopupWindow(ev.target)) {
      return;
    }

    // Clear the highlight since it interferes with selection.
    this.clearHighlight(ev.target as Element);
  }

  onKeyDown(ev: KeyboardEvent) {
    const textBoxInFocus =
      document.activeElement && isEditableNode(document.activeElement);

    // If the user pressed the hold-to-show key combination, show the popup
    // if possible.
    //
    // We don't do this when the there is a text box in focus because we
    // we risk interfering with the text selection when, for example, the
    // hold-to-show key is Ctrl and the user presses Ctrl+V etc.
    if (this.isHoldToShowKeysMatch(ev)) {
      ev.preventDefault();

      if (!textBoxInFocus && this.currentPoint && this.currentTarget) {
        this.tryToUpdatePopup(this.currentPoint, this.currentTarget, 'default');
      }
      return;
    }

    // If we got shift in combination with something else, ignore.
    //
    // We need to allow shift by itself because it is used for switching
    // dictionaries. However, if the user presses, Cmd + Shift + 3, for example,
    // we should ignore the last two keystrokes.
    //
    // TODO: We should refine this somehow so that it's possible to toggle
    // dictionaries using Shift while pressing the hold-to-show keys.
    //
    // See https://github.com/birchill/10ten-ja-reader/issues/658
    if (
      ev.shiftKey &&
      (ev.ctrlKey || ev.altKey || ev.metaKey || ev.key !== 'Shift')
    ) {
      this.typingMode = true;
      return;
    }

    // If we're not visible we should ignore any keystrokes.
    if (!this.isVisible()) {
      this.typingMode = true;
      return;
    }

    // If we're focussed on a text-editable node and in typing mode, listen to
    // keystrokes.
    if (textBoxInFocus && this.typingMode) {
      return;
    }

    if (this.handleKey(ev.key, ev.ctrlKey)) {
      // We handled the key stroke so we should break out of typing mode.
      this.typingMode = false;

      ev.stopPropagation();
      ev.preventDefault();
    } else if (textBoxInFocus) {
      // If we are focussed on a textbox and the keystroke wasn't one we handle
      // one, enter typing mode and hide the pop-up.
      if (textBoxInFocus) {
        this.clearHighlight(this.currentTarget);
        this.typingMode = true;
      }
    }
  }

  onKeyUp(ev: KeyboardEvent) {
    if (!this.kanjiLookupMode) {
      return;
    }

    if (ev.key === 'Shift') {
      this.kanjiLookupMode = false;
      ev.preventDefault();
    }
  }

  handleKey(key: string, ctrlKeyPressed: boolean): boolean {
    // Make an upper-case version of the list of keys so that we can do
    // a case-insensitive comparison. This is so that the keys continue to work
    // even when the user has Caps Lock on.
    const toUpper = (keys: string[]): string[] =>
      keys.map((key) => key.toUpperCase());
    let { keys } = this.config;
    const [
      nextDictionary,
      toggleDefinition,
      movePopupUp,
      movePopupDown,
      startCopy,
    ] = [
      toUpper(keys.nextDictionary),
      toUpper(keys.toggleDefinition),
      toUpper(keys.movePopupUp),
      toUpper(keys.movePopupDown),
      toUpper(keys.startCopy),
    ];

    const upperKey = key.toUpperCase();

    if (nextDictionary.includes(upperKey)) {
      // If we are in kanji lookup mode, ignore 'Shift' keydown events since it
      // is also the key we use to trigger lookup mode.
      if (key === 'Shift' && this.kanjiLookupMode) {
        return true;
      }
      if (this.currentPoint && this.currentTarget) {
        this.showDictionary('next');
      }
    } else if (toggleDefinition.includes(upperKey)) {
      try {
        browser.runtime.sendMessage({ type: 'toggleDefinition' });
      } catch (e) {
        console.log(
          '[10ten-ja-reader] Failed to call toggleDefinition. The page might need to be refreshed.'
        );
        return false;
      }
      // We'll eventually get notified of the config change but we just change
      // it here now so we can update the popup immediately.
      this.config.readingOnly = !this.config.readingOnly;
      this.showPopup();
    } else if (movePopupDown.includes(upperKey)) {
      this.popupPositionMode =
        (this.popupPositionMode + 1) % (PopupPositionMode.End + 1);
      this.showPopup();
    } else if (movePopupUp.includes(upperKey)) {
      this.popupPositionMode = mod(
        this.popupPositionMode - 1,
        PopupPositionMode.End + 1
      );
      this.showPopup();
    } else if (
      navigator.clipboard &&
      // It's important we _don't_ enter copy mode when the Ctrl key is being
      // pressed since otherwise if the user simply wants to copy the selected
      // text by pressing Ctrl+C they will end up entering copy mode.
      !ctrlKeyPressed &&
      startCopy.includes(upperKey) &&
      this.currentSearchResult
    ) {
      if (this.copyMode) {
        this.copyIndex++;
      } else {
        this.copyMode = true;
        this.copyIndex = 0;
      }
      this.showPopup();
    } else if (this.copyMode && key === 'Escape') {
      this.copyMode = false;
      this.showPopup();
    } else if (this.copyMode) {
      let copyType: CopyType | undefined;
      for (const copyKey of CopyKeys) {
        if (upperKey === copyKey.key.toUpperCase()) {
          copyType = copyKey.type;
          break;
        }
      }

      if (typeof copyType === 'undefined') {
        // Unrecognized key
        return false;
      }

      const copyEntry = this.getCopyEntry();
      if (!copyEntry) {
        return true;
      }

      let textToCopy: string;

      switch (copyType) {
        case CopyType.Entry:
          textToCopy = getEntryToCopy(copyEntry, {
            kanjiReferences: this.config.kanjiReferences,
            showKanjiComponents: this.config.showKanjiComponents,
          });
          break;

        case CopyType.TabDelimited:
          textToCopy = getFieldsToCopy(copyEntry, {
            kanjiReferences: this.config.kanjiReferences,
            showKanjiComponents: this.config.showKanjiComponents,
          });
          break;

        case CopyType.Word:
          textToCopy = getWordToCopy(copyEntry);
          break;
      }

      this.copyString(textToCopy!, copyType);
    } else {
      return false;
    }

    return true;
  }

  onFocusIn(ev: FocusEvent) {
    if (this.ignoreFocusEvent) {
      return;
    }

    // If we focussed on a text box, assume we want to type in it and ignore
    // keystrokes until we get another mousemove.
    this.typingMode = !!ev.target && isEditableNode(ev.target as Node);

    // Update the previous focus.
    if (!this.previousFocus || this.previousFocus !== ev.target) {
      this.previousFocus = ev.target as Element;
      this.storeSelection(this.previousFocus.ownerDocument!.defaultView!);
    }

    // If we entered typing mode clear the highlight.
    if (this.typingMode) {
      this.clearHighlight(this.currentTarget);
    }
  }

  // Test if an incoming keyboard event matches the hold-to-show key sequence
  isHoldToShowKeysMatch(ev: KeyboardEvent): boolean {
    if (!this.config.holdToShowKeys.length) {
      return false;
    }

    // Check if it is a modifier at all
    if (!['Alt', 'AltGraph', 'Control'].includes(ev.key)) {
      return false;
    }

    return this.areHoldToShowKeysDown(ev);
  }

  // Test if hold-to-show keys are set for a given a UI event
  areHoldToShowKeysDown(ev: MouseEvent | KeyboardEvent): boolean {
    if (!this.config.holdToShowKeys.length) {
      return true;
    }

    // Check if all the configured hold-to-show keys are pressed down
    const isAltGraph = ev.getModifierState('AltGraph');
    if (
      this.config.holdToShowKeys.includes('Alt') &&
      !ev.altKey &&
      !isAltGraph
    ) {
      return false;
    }
    if (this.config.holdToShowKeys.includes('Ctrl') && !ev.ctrlKey) {
      return false;
    }

    return true;
  }

  isVisible(): boolean {
    return isPopupVisible();
  }

  async tryToUpdatePopup(
    point: { x: number; y: number },
    target: Element,
    dictMode: 'default' | 'kanji'
  ) {
    const textAtPoint = getTextAtPoint(point, ContentHandler.MAX_LENGTH);

    // The following is not strictly correct since if dictMode was 'kanji' or
    // 'next' but is now 'default' then technically we shouldn't return early
    // since the result will likely differ.
    //
    // In practice, however, locking the result to the previously shown
    // dictionary in this case is not a problem. On the contrary it makes
    // toggling dictionaries a little less sensitive to minor mouse movements
    // and hence easier to work with.
    if (
      JSON.stringify(this.currentTextAtPoint) === JSON.stringify(textAtPoint) &&
      dictMode === 'default'
    ) {
      return;
    }

    this.currentTextAtPoint = textAtPoint;
    this.currentPoint = point;

    // The text or dictionary has changed so break out of copy mode
    this.copyMode = false;

    if (!textAtPoint) {
      this.clearHighlight(target);
      return;
    }

    let queryResult = await query(textAtPoint.text, {
      includeRomaji: this.config.showRomaji,
      wordLookup: textAtPoint.rangeStart !== null,
    });

    // Check if we have triggered a new query or been disabled while running
    // the previous query.
    if (!this.currentTextAtPoint || textAtPoint !== this.currentTextAtPoint) {
      return;
    }

    if (!queryResult && !textAtPoint.meta) {
      this.clearHighlight(target);
      return;
    }

    // Determine the dictionary to show
    let dict: MajorDataSeries = 'words';

    if (queryResult) {
      switch (dictMode) {
        case 'default':
          if (!queryResult.words) {
            // Prefer the names dictionary if we have a names result of more
            // than one character or if we have no kanji results.
            //
            // Otherwise, follow the usual fallback order words -> kanji ->
            // names.
            dict =
              (queryResult.names && queryResult.names.matchLen > 1) ||
              !queryResult.kanji
                ? 'names'
                : 'kanji';
          }
          break;

        case 'kanji':
          if (!queryResult.kanji) {
            queryResult = null;
          } else {
            dict = 'kanji';
          }
          break;
      }

      this.currentDict = dict;
    }

    this.highlightText(textAtPoint, queryResult?.[dict]);

    this.currentSearchResult = queryResult;
    this.currentTarget = target;

    this.showPopup();
  }

  showDictionary(dictToShow: 'next' | MajorDataSeries) {
    if (!this.currentSearchResult || !this.currentTextAtPoint) {
      return;
    }

    let dict: MajorDataSeries;

    if (dictToShow == 'next') {
      dict = this.currentDict;

      const cycleOrder: Array<MajorDataSeries> = ['words', 'kanji', 'names'];
      let next = (cycleOrder.indexOf(this.currentDict) + 1) % cycleOrder.length;
      while (cycleOrder[next] !== this.currentDict) {
        const nextDict = cycleOrder[next];
        if (this.currentSearchResult[nextDict]) {
          dict = nextDict;
          break;
        }
        next = ++next % cycleOrder.length;
      }
    } else {
      dict = dictToShow;
    }

    if (dict === this.currentDict) {
      return;
    }

    // The user has successfully switched dictionaries. If this is the first
    // time that's happened, store the result so we don't pester the user
    // with prompts about how to change dictionaries.
    if (!this.config.hasSwitchedDictionary) {
      try {
        browser.runtime.sendMessage({ type: 'switchedDictionary' });
      } catch (e) {
        console.log(
          '[10ten-ja-reader] Failed to call switchedDictionary. The page might need to be refreshed.'
        );
      }
      // Make sure this applies immediately
      this.config.hasSwitchedDictionary = true;
    }

    this.currentDict = dict;

    this.highlightText(this.currentTextAtPoint, this.currentSearchResult[dict]);

    this.showPopup();
  }

  highlightText(
    textAtPoint: GetTextResult,
    searchResult: { matchLen: number } | undefined | null
  ) {
    if (this.config.noTextHighlight) {
      return;
    }

    // Work out the appropriate length to highlight
    const matchLen = Math.max(
      searchResult?.matchLen || 0,
      textAtPoint.meta?.matchLen || 0
    );

    // Check we have something to highlight
    if (!textAtPoint.rangeStart || matchLen < 1) {
      return;
    }

    const selectedWindow =
      textAtPoint.rangeStart.container.ownerDocument!.defaultView!;

    // Check that the window wasn't closed since we started the lookup
    if (!selectedWindow || selectedWindow.closed) {
      this.clearHighlight(null);
      return;
    }

    // Check if there is already something selected in the page that is *not*
    // what we selected. If there is we generally want to leave it alone unless
    // it's a selection in a contenteditable node---in that case we want to
    // store and restore it to mimic the behavior of textboxes.
    const selection = selectedWindow.getSelection();
    if (!selection) {
      // If there is no selection, we're probably dealing with an iframe that
      // has now become display:none.
      this.clearHighlight(null);
      return;
    }

    if (isContentEditableNode(selection.anchorNode)) {
      if (
        !this.previousSelection &&
        selection.toString() !== this.selectedText
      ) {
        this.storeSelection(selectedWindow);
      }
    } else if (
      selection.toString() &&
      selection.toString() !== this.selectedText
    ) {
      this.selectedText = null;
      return;
    }

    // Handle textarea/input selection separately since those elements have
    // a different selection API.
    if (isTextInputNode(textAtPoint.rangeStart.container)) {
      const node = textAtPoint.rangeStart.container;
      const start = textAtPoint.rangeStart.offset;
      const end = start + matchLen;

      // If we were previously interacting with a different text box, restore
      // its range.
      if (this.selectedTextBox && node !== this.selectedTextBox.node) {
        this.restoreTextBoxSelection();
      }

      // If we were not already interacting with this text box, store its
      // existing range and focus it.
      if (!this.selectedTextBox || node !== this.selectedTextBox.node) {
        // Record the original focus if we haven't already, so that we can
        // restore it.
        if (!this.previousFocus) {
          this.previousFocus = document.activeElement;
        }

        // I haven't found a suitable way of detecting changes in focus due to
        // the user actually selecting a field (which we want to reflect when we
        // go to restore the focus) and changes in focus due to our focus
        // management so for now we just use this terribly hacky approach to
        // filter out our focus events.
        console.assert(!this.ignoreFocusEvent);
        this.ignoreFocusEvent = true;
        node.focus();
        this.ignoreFocusEvent = false;

        this.selectedTextBox = {
          node,
          previousStart: node.selectionStart,
          previousEnd: node.selectionEnd,
          previousDirection: node.selectionDirection,
        };
      }

      // Store the current scroll range so we can restore it.
      const { scrollTop, scrollLeft } = node;

      // Clear any other selection happening in the page.
      selection.removeAllRanges();

      node.setSelectionRange(start, end);
      this.selectedText = node.value.substring(start, end);
      this.selectedWindow = selectedWindow;

      // Restore the scroll range. We need to do this on the next tick or else
      // something else (not sure what) will clobber it.
      requestAnimationFrame(() => {
        node.scrollLeft = scrollLeft;
        node.scrollTop = scrollTop;
      });
    } else {
      // If we were previously interacting with a text box, restore its range
      // and blur it.
      this.clearTextBoxSelection(null);

      const startNode = textAtPoint.rangeStart.container;
      const startOffset = textAtPoint.rangeStart.offset;
      let endNode = startNode;
      let endOffset = startOffset;

      let currentLen = 0;
      for (
        let i = 0;
        currentLen < matchLen && i < textAtPoint.rangeEnds.length;
        i++
      ) {
        const initialOffset = i == 0 ? startOffset : 0;
        endNode = textAtPoint.rangeEnds[i].container;
        const len = Math.min(
          textAtPoint.rangeEnds[i].offset - initialOffset,
          matchLen - currentLen
        );
        endOffset = initialOffset + len;
        currentLen += len;
      }

      const range = startNode.ownerDocument!.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);

      const selection = selectedWindow.getSelection();
      // (We checked for the case of selection being null above so it should be
      // ok to assume it is non-null here.)
      selection!.removeAllRanges();
      selection!.addRange(range);
      this.selectedText = selection!.toString();
      this.selectedWindow = selectedWindow;
    }
  }

  clearHighlight(currentElement: Element | null) {
    this.currentTextAtPoint = null;
    this.currentPoint = null;
    this.currentSearchResult = null;
    this.currentTarget = null;
    this.copyMode = false;

    if (this.selectedWindow && !this.selectedWindow.closed) {
      const selection = this.selectedWindow.getSelection();
      // Clear the selection if it's something we made.
      if (
        selection &&
        (!selection.toString() || selection.toString() === this.selectedText)
      ) {
        if (this.previousSelection) {
          this.restoreSelection();
        } else {
          selection.removeAllRanges();
        }
      }

      this.clearTextBoxSelection(currentElement);
    }

    this.selectedWindow = null;
    this.selectedText = null;

    hidePopup();
  }

  storeSelection(selectedWindow: Window) {
    const selection = selectedWindow.getSelection();
    if (selection && isContentEditableNode(selection.anchorNode)) {
      // We don't actually store the full selection, basically because we're
      // lazy. Remembering the cursor position is hopefully good enough for
      // now anyway.
      this.previousSelection = {
        node: selection.anchorNode!,
        offset: selection.anchorOffset,
      };
    } else {
      this.previousSelection = null;
    }
  }

  restoreSelection() {
    if (!this.previousSelection) {
      return;
    }

    const { node, offset } = this.previousSelection;
    const range = node.ownerDocument!.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset);

    const selection = node.ownerDocument!.defaultView!.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    this.previousSelection = null;
  }

  clearTextBoxSelection(currentElement: Element | null) {
    if (!this.selectedTextBox) {
      return;
    }

    const textBox = this.selectedTextBox.node;

    // Store the previous scroll position so we can restore it, if need be.
    const { scrollTop, scrollLeft } = textBox;

    this.restoreTextBoxSelection();

    // If we are still interacting with the textBox, make sure to maintain its
    // scroll position (rather than jumping back to wherever the restored
    // selection is just because we didn't find a match).
    if (currentElement === textBox) {
      // As before, we need to restore this in the next tick or else it will get
      // clobbered.
      requestAnimationFrame(() => {
        textBox.scrollLeft = scrollLeft;
        textBox.scrollTop = scrollTop;
      });
    }

    // If we only focussed the textbox in order to highlight text, restore the
    // previous focus.
    //
    // (We need to do this even if currentElement === textBox since we'll lose
    // the previous focus when we reset _selectedTextBox and we if we don't
    // restore the focus now, when we next go to set previousFocus we'll end up
    // using `textBox` instead.)
    if (isFocusable(this.previousFocus) && this.previousFocus !== textBox) {
      // First blur the text box since some Elements' focus() method does
      // nothing.
      this.selectedTextBox.node.blur();

      // Very hacky approach to filtering out our own focus handling.
      console.assert(!this.ignoreFocusEvent);
      this.ignoreFocusEvent = true;
      this.previousFocus.focus();
      this.ignoreFocusEvent = false;
    }

    this.selectedTextBox = null;
    this.previousFocus = null;
  }

  restoreTextBoxSelection() {
    if (!this.selectedTextBox) {
      return;
    }

    const textBox = this.selectedTextBox.node;
    textBox.selectionStart = this.selectedTextBox.previousStart;
    textBox.selectionEnd = this.selectedTextBox.previousEnd;
    textBox.selectionDirection = this.selectedTextBox.previousDirection;
  }

  showPopup(options?: { copyState?: CopyState; copyType?: CopyType }) {
    if (!this.currentSearchResult && !this.currentTextAtPoint?.meta) {
      this.clearHighlight(this.currentTarget);
      return;
    }

    const doc: Document = this.currentTarget?.ownerDocument ?? window.document;
    const popupOptions: PopupOptions = {
      accentDisplay: this.config.accentDisplay,
      copyIndex: this.copyIndex,
      copyNextKey: this.config.keys.startCopy[0] || '',
      copyState:
        options?.copyState ||
        (this.copyMode ? CopyState.Active : CopyState.Inactive),
      copyType: options?.copyType,
      dictLang: this.config.dictLang,
      dictToShow: this.currentDict,
      document: doc,
      hasSwitchedDictionary: this.config.hasSwitchedDictionary,
      kanjiReferences: this.config.kanjiReferences,
      meta: this.currentTextAtPoint?.meta,
      onClosePopup: () => {
        this.clearHighlight(this.currentTarget);
      },
      onSwitchDictionary: (dict: MajorDataSeries) => {
        this.showDictionary(dict);
      },
      popupStyle: this.config.popupStyle,
      posDisplay: this.config.posDisplay,
      showDefinitions: !this.config.readingOnly,
      showKanjiComponents: this.config.showKanjiComponents,
      showPriority: this.config.showPriority,
      switchDictionaryKeys: this.config.keys.nextDictionary,
    };

    const popup = renderPopup(this.currentSearchResult, popupOptions);
    if (!popup) {
      this.clearHighlight(this.currentTarget);
      return;
    }

    // Position the popup
    const {
      x: popupX,
      y: popupY,
      constrainWidth,
      constrainHeight,
    } = getPopupPosition({
      doc,
      mousePos: this.currentPoint,
      positionMode: this.popupPositionMode,
      popupSize: {
        width: popup.offsetWidth || 200,
        height: popup.offsetHeight,
      },
      targetElem: this.currentTarget,
    });

    if (
      isSvgDoc(doc) &&
      isSvgSvgElement(doc.documentElement) &&
      isForeignObjectElement(popup.parentElement)
    ) {
      // Set the x/y attributes on the <foreignObject> wrapper after converting
      // to document space.
      const svg: SVGSVGElement = doc.documentElement;
      const wrapper: SVGForeignObjectElement = popup.parentElement;
      wrapper.x.baseVal.value = popupX;
      wrapper.y.baseVal.value = popupY;
      const ctm = svg.getScreenCTM();
      if (ctm) {
        const transform = svg.createSVGTransformFromMatrix(ctm.inverse());
        wrapper.transform.baseVal.initialize(transform);
      }
    } else {
      popup.style.left = `${popupX}px`;
      popup.style.top = `${popupY}px`;
      popup.style.maxWidth = constrainWidth ? `${constrainWidth}px` : 'none';
      popup.style.maxHeight = constrainHeight ? `${constrainHeight}px` : 'none';
      if (constrainHeight) {
        popup.style.maskImage =
          'linear-gradient(to bottom, black 99%, transparent)';
      } else {
        popup.style.maskImage = 'none';
      }
    }
  }

  private getCopyEntry(): CopyEntry | null {
    console.assert(
      this.copyMode,
      'Should be in copy mode when copying an entry'
    );

    if (
      !this.currentSearchResult ||
      !this.currentSearchResult[this.currentDict]
    ) {
      return null;
    }

    const searchResult = this.currentSearchResult[this.currentDict]!;

    let copyIndex = this.copyIndex;
    if (searchResult.type === 'words' || searchResult.type === 'names') {
      copyIndex = copyIndex % searchResult.data.length;
    }

    if (copyIndex < 0) {
      console.error('Bad copy index');
      this.copyMode = false;
      this.showPopup();
      return null;
    }

    switch (searchResult.type) {
      case 'words':
        return { type: 'word', data: searchResult.data[copyIndex] };

      case 'names':
        return { type: 'name', data: searchResult.data[copyIndex] };

      case 'kanji':
        return { type: 'kanji', data: searchResult.data };
    }
  }

  private async copyString(message: string, copyType: CopyType) {
    let copyState = CopyState.Finished;
    try {
      await navigator.clipboard.writeText(message);
    } catch (e) {
      copyState = CopyState.Error;
      console.error('Failed to write to clipboard', e);
    }

    this.copyMode = false;
    this.showPopup({ copyState, copyType });
  }

  // Expose the renderPopup callback so that we can test it
  _renderPopup = renderPopup;
}

declare global {
  interface Window {
    readerScriptVer?: string;
    removeReaderScript?: () => void;
  }
}

(function () {
  // Ensure the content script is not loaded twice or that an incompatible
  // version of the script is not used.
  //
  // This is only needed when we are injecting the script via executeScript
  // when running in "activeTab" mode.
  //
  // Furthermore, with regards to incompatible versions, as far as I can tell
  // Firefox will remove old versions of injected scripts when it reloads an
  // add-on. I'm not sure if that behavior is reliable across all browsers,
  // however, so for now we try our best to ensure we have the correct version
  // of the script here.
  if (window.readerScriptVer === __VERSION__) {
    return;
  } else if (
    typeof window.readerScriptVer !== 'undefined' &&
    typeof window.removeReaderScript === 'function'
  ) {
    console.log(
      '[10ten-ja-reader] Found incompatible version of script. Removing.'
    );
    try {
      window.removeReaderScript();
    } catch (e) {
      console.error(e);
    }
  }

  let contentHandler: ContentHandler | null = null;

  // Port to the background page.
  //
  // This is only used when we are running in "activeTab" mode. It serves to:
  //
  // - Provide an extra means to ensure the tab is removed from the list of
  //   enabled tabs when the tab is destroyed (in case we fail to get a pagehide
  //   event), and
  // - Ensure the background page is kept alive so long as we have an enabled
  //   tab when the background page is running as an event page.
  //
  let port: Browser.Runtime.Port | undefined;

  // Selection puck
  const puck = new RikaiPuck();
  let theme = 'default';

  window.readerScriptVer = __VERSION__;
  window.removeReaderScript = () => {
    disable();
    puck.unmount();
    browser.runtime.onMessage.removeListener(onMessage);
  };

  browser.runtime.onMessage.addListener(onMessage);

  // Check if we should be enabled or not.
  //
  // We don't need to do this in activeTab mode since the background page will
  // send us an 'enable' message after injecting the script.
  //
  // However, when the content script is injected using content_scripts the
  // background script might not have been initialized yet in which case this
  // will fail. However, presumably once the background script has initialized
  // it will call us if we need to be enabled.
  if (!__ACTIVE_TAB_ONLY__) {
    browser.runtime.sendMessage({ type: 'enable?' }).catch(() => {
      // Ignore
    });
  }

  // Render the puck
  if (document.readyState !== 'loading') {
    renderPuck();
  } else {
    window.addEventListener('DOMContentLoaded', renderPuck);
  }

  function renderPuck() {
    puck.render({ doc: document, theme });
    puck.enable();
  }

  function onMessage(request: any): Promise<string> {
    if (typeof request.type !== 'string') {
      return Promise.reject(
        new Error(`Invalid request: ${JSON.stringify(request.type)}`)
      );
    }

    switch (request.type) {
      case 'enable':
        console.assert(
          typeof request.config === 'object',
          'No config object provided with enable message'
        );

        if (request.config.popupStyle !== theme) {
          theme = request.config.popupStyle;
          puck.setTheme(theme);
        }

        const tabId: number | undefined =
          typeof request.id === 'number' ? request.id : undefined;
        enable({ tabId, config: request.config });

        return Promise.resolve('ok');

      case 'disable':
        disable();

        return Promise.resolve('ok');

      default:
        return Promise.reject(
          new Error(`Unrecognized request: ${JSON.stringify(request.type)}`)
        );
    }
  }

  function enable({
    tabId,
    config,
  }: {
    tabId?: number;
    config: ContentConfig;
  }) {
    if (contentHandler) {
      contentHandler.setConfig(config);
    } else {
      // When the extension is upgraded, we can still have the old popup
      // window hanging around so make sure to clear it.
      removePopup();
      contentHandler = new ContentHandler(config);
    }

    // If we are running in "activeTab" mode we will get passed our tab ID
    // so we can set up a Port which will allow the background script to
    // know when we disappear so it can update the browser action status.
    //
    // We only need to do that if we're the root-most frame, however.
    if (typeof tabId !== 'undefined' && window.top === window.self && !port) {
      try {
        port = browser.runtime.connect(undefined, {
          name: `tab-${tabId}`,
        });
      } catch (e) {
        console.error(e);
      }
    }

    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('pagehide', onPageHide);
  }

  function disable() {
    if (contentHandler) {
      contentHandler.detach();
      contentHandler = null;
    }

    if (port) {
      port.disconnect();
      port = undefined;
    }

    window.removeEventListener('pageshow', onPageShow);
    window.removeEventListener('pagehide', onPageHide);
  }

  function onPageShow() {
    browser.runtime.sendMessage({ type: 'enable?' });
  }

  function onPageHide() {
    browser.runtime.sendMessage({ type: 'disabled' });
  }
})();

export default ContentHandler;
