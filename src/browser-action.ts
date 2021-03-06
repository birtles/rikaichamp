import { allMajorDataSeries, DataSeriesState } from '@birchill/hikibiki-data';
import { browser } from 'webextension-polyfill-ts';

import { JpdictStateWithFallback } from './jpdict';

interface BrowserActionState {
  enabled: boolean;
  jpdictState: JpdictStateWithFallback;
  tabId: number | undefined;
}

export function updateBrowserAction({
  enabled,
  jpdictState,
  tabId,
}: BrowserActionState) {
  let iconFilename = '10ten-disabled';
  let titleStringId = 'command_toggle_disabled';

  // First choose the base icon type / text
  if (enabled) {
    const jpdictWords = jpdictState.words.state;
    const fallbackWords = jpdictState.words.fallbackState;

    if (jpdictWords === DataSeriesState.Ok || fallbackWords === 'ok') {
      iconFilename = '10ten';
      titleStringId = 'command_toggle_enabled';
    } else if (
      jpdictWords === DataSeriesState.Initializing ||
      fallbackWords === 'loading'
    ) {
      titleStringId = 'command_toggle_loading';
    } else if (fallbackWords === 'unloaded') {
      // If we get this far, we've either failed to load the jpdict database or
      // we simply haven't got around to populating it yet (e.g. we're still
      // downloading the other databases).
      //
      // However, we won't load the fallback database until the user actually
      // tries to look something up so we don't know if it's available yet or
      // not. For now, assume everything is ok.
      iconFilename = '10ten';
      titleStringId = 'command_toggle_enabled';
    } else {
      iconFilename = '10ten-error';
      titleStringId = 'error_loading_dictionary';
    }
  }

  // Next determine if we need to overlay any additional information.
  switch (jpdictState.updateState.state) {
    case 'checking':
      // Technically the '-indeterminate' icon would be more correct here but
      // using '-0' instead leads to less flicker.
      iconFilename += '-0';
      titleStringId = 'command_toggle_checking';
      break;

    case 'downloading':
    case 'updatingdb':
      // We only have progress variants for the regular and disabled styles.
      if (['10ten', '10ten-disabled'].includes(iconFilename)) {
        iconFilename +=
          '-' + Math.round(jpdictState.updateState.progress * 5) * 20;
      }
      titleStringId =
        jpdictState.updateState.state === 'downloading'
          ? 'command_toggle_downloading'
          : 'command_toggle_updating';
      break;
  }

  // Set the icon
  //
  // We'd like to feature-detect if SVG icons are supported but Safari will
  // just fail silently if we try.
  if (__SUPPORTS_SVG_ICONS__) {
    browser.browserAction.setIcon({
      path: `images/${iconFilename}.svg`,
      tabId,
    });
  } else {
    browser.browserAction.setIcon({
      path: {
        16: `images/${iconFilename}-16.png`,
        32: `images/${iconFilename}-32.png`,
        48: `images/${iconFilename}-48.png`,
      },
      tabId,
    });
  }

  // Add a warning overlay and update the string if there was a fatal
  // update error.
  const hasNotOkDatabase = allMajorDataSeries.some(
    (series) => jpdictState[series].state !== DataSeriesState.Ok
  );
  if (
    hasNotOkDatabase &&
    !!jpdictState.updateError &&
    jpdictState.updateError.name !== 'AbortError' &&
    // Don't show quota exceeded errors. If the quota is exceeded, there's not
    // a lot the user can do about it, and we don't want to bother them with
    // a constant error signal.
    jpdictState.updateError.name !== 'QuotaExceededError'
  ) {
    browser.browserAction.setBadgeText({ text: '!', tabId });
    browser.browserAction.setBadgeBackgroundColor({
      color: 'yellow',
      tabId,
    });
    titleStringId = 'command_toggle_update_error';
  } else {
    browser.browserAction.setBadgeText({ text: '', tabId });
  }

  // Set the caption
  browser.browserAction.setTitle({
    title: browser.i18n.getMessage(titleStringId),
    tabId,
  });
}
