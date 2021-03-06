import Bugsnag from '@bugsnag/js';
import Browser, { browser } from 'webextension-polyfill-ts';

import { isBackgroundRequest } from './background-request';
import { ContentConfig } from './content-config';
import {
  EnabledChangedCallback,
  TabManager,
  EnabledState,
} from './tab-manager';

type EnabledTab = {
  id: number;
  port: Browser.Runtime.Port | undefined;
};

export default class ActiveTabManager implements TabManager {
  private config: ContentConfig | undefined;
  // It's ok to initialize this to an empty array even if we're being run as an
  // event page that's just been resumed since we only track enabled tabs and
  // any enabled tabs will set up a message port that will keep the background
  // page alive. As a result, if we're being resumed, we must have zero enabled
  // tabs (so far).
  private enabledTabs: Array<EnabledTab> = [];
  private listeners: Array<EnabledChangedCallback> = [];

  async init(config: ContentConfig): Promise<void> {
    this.config = config;

    // Notify listeners when the active tab changes
    browser.tabs.onActivated.addListener(({ tabId }) => {
      const enabled = this.enabledTabs.some((t) => t.id === tabId);
      this.notifyListeners(enabled, tabId);
    });

    browser.runtime.onConnect.addListener(this.onConnect.bind(this));

    // Response to enable?/disabled messages
    browser.runtime.onMessage.addListener(
      (
        request: any,
        sender: Browser.Runtime.MessageSender
      ): void | Promise<any> => {
        // Basic sanity checks
        if (!isBackgroundRequest(request)) {
          return;
        }

        // We only handle messages from tabs
        if (!sender.tab || typeof sender.tab.id !== 'number') {
          return;
        }

        switch (request.type) {
          case 'enable?':
            this.enablePage(sender.tab.id, sender.frameId);
            break;

          case 'disabled':
            this.onPageDisabled(sender.tab.id, sender.frameId);
            break;
        }
      }
    );
  }

  //
  // Port management
  //

  private onConnect(port: Browser.Runtime.Port) {
    // If we get a connection, store the port. We don't actually use this at
    // the moment, except as a means to keep the background page alive while
    // we have an enabled tab somewhere.
    if (!port.name.startsWith('tab-')) {
      return;
    }

    const id = parseInt(port.name.substring('tab-'.length), 10);
    if (!id) {
      return;
    }

    const tab = this.enabledTabs.find((t) => t.id === id);
    if (!tab) {
      return;
    }

    tab.port = port;

    port.onDisconnect.addListener(() => this.onPageDisabled(id));
  }

  //
  // State queries
  //

  async getEnabledState(): Promise<Array<EnabledState>> {
    // For each active tab in each window, see if it is enabled
    const result: Array<EnabledState> = [];

    try {
      const activeTabs = await browser.tabs.query({ active: true });
      for (const tab of activeTabs) {
        const enabled = this.enabledTabs.some((t) => t.id === tab.id);
        result.push({ enabled, tabId: tab.id });
      }
    } catch (e) {
      Bugsnag.notify(e);
    }

    return result;
  }

  //
  // Toggling related interface
  //

  async toggleTab(tab: Browser.Tabs.Tab, config: ContentConfig) {
    if (typeof tab.id === 'undefined') {
      return;
    }

    // First, determine if we want to disable or enable
    const enabled = !this.enabledTabs.some((t) => t.id === tab.id);

    if (enabled) {
      this.config = config;
      await this.enablePage(tab.id);
    } else {
      // It's important we drop the entry from the enabledTabs array before we
      // notify the content script. Otherwise when the content script
      // disconnects itself we'll think it should still be enabled and try to
      // re-inject ourselves.
      this.enabledTabs = this.enabledTabs.filter((t) => t.id !== tab.id);
      try {
        await browser.tabs.sendMessage(tab.id, { type: 'disable' });
      } catch (e) {
        Bugsnag.notify(e);
      }

      this.notifyListeners(false, tab.id);
    }
  }

  private async enablePage(tabId: number, frameId?: number): Promise<void> {
    if (!this.config) {
      throw new Error('Should have called init before enablePage');
    }

    // Update our local list of enabled tabs, if needed.
    //
    // We do this even before we know if we will successfully set up the content
    // script because once the content script _is_ set up, it might end up
    // trying to connect to us before sendMessage returns and we want
    // enabledTabs to be up-to-date by that point.
    //
    // If we fail to set up the content script we'll drop the entry from
    // enabledTabs at that point.
    //
    // However, we only want to change the enabled state if we are dealing with
    // the root frame or the whole tab.
    const isRootFrame = typeof frameId === 'undefined' || frameId === 0;
    if (isRootFrame && !this.enabledTabs.some((t) => t.id === tabId)) {
      this.enabledTabs.push({ id: tabId, port: undefined });
    }

    // If we are dealing with a single frame, try calling to see if the content
    // script is already injected.
    //
    // We can't do that if we are dealing with a whole tab, however, since
    // sendMessage only returns the result of the first frame to answer.
    //
    // So in that case we just have to blindly inject the script and trust the
    // content script to return early if it finds it has already been injected.
    let enabled = true;
    if (
      typeof frameId === 'undefined' ||
      !(await this.tryEnablingFrame(tabId, frameId))
    ) {
      // Looks like we need to try and inject the script instead.
      try {
        await this.injectScript(tabId, frameId);
      } catch (e) {
        Bugsnag.notify(e);

        enabled = false;
        // Drop the enabled tab from our list, but only if we're dealing with
        // the root frame or the whole tab.
        if (isRootFrame) {
          this.enabledTabs = this.enabledTabs.filter((t) => t.id !== tabId);
        }
      }
    }

    // Notify listeners regardless of whether or not we updated enabledTabs.
    //
    // We need to do this because during navigation, the browser can reset the
    // browser action to its non-active state without telling us so even if the
    // tab is already in enabledTabs, we may still need to update the browser
    // action to reflect that.
    if (isRootFrame) {
      this.notifyListeners(enabled, tabId);
    }
  }

  private async tryEnablingFrame(
    tabId: number,
    frameId: number
  ): Promise<boolean> {
    if (!this.config) {
      throw new Error('Should have called init before isFrameEnabled');
    }

    try {
      const result = await browser.tabs.sendMessage(
        tabId,
        {
          type: 'enable',
          config: this.config,
          id: tabId,
        },
        { frameId }
      );
      // We need to check we got the expected result because Safari simply fails
      // silently if no one received the message.
      return result === 'ok';
    } catch (_e) {
      return false;
    }
  }

  private async injectScript(tabId: number, frameId?: number): Promise<void> {
    // Inject the script
    await browser.tabs.executeScript(tabId, {
      allFrames: typeof frameId === 'undefined',
      file: '/10ten-ja-content.js',
      runAt: 'document_start',
      frameId,
    });

    // We'd really like to detect if we failed to inject into the root frame
    // (since we report our enabled state based on whether or not the the root
    // frame is successfully enabled).
    //
    // However, there doesn't seem to be any easy way to do that.
    //
    // executeScript returns an array of results from each frame we injected the
    // script into. If the script returns nothing, Firefox reports 'undefined'
    // while Chrome reports 'null'. However, it's not clear if these results are
    // ordered by frame or not, or how to actually return a meaningful value
    // given the way we package our content script. What's more, if any of the
    // frames throws an error, theo whole call executeScript call fails.
    //
    // So, for now, we just rely on the call site doing some guessing about
    // whether or not we should report ourselves as being enabled or not.

    // Now send the enable message.
    await browser.tabs.sendMessage(
      tabId,
      {
        type: 'enable',
        config: this.config,
        id: tabId,
      },
      { frameId }
    );
  }

  private async onPageDisabled(tabId: number, frameId?: number) {
    // If we already believe the page to be disabled, there's nothing more to
    // do.
    if (!this.enabledTabs.some((t) => t.id === tabId)) {
      return;
    }

    // We only modify enabledTabs and we only report changes to the enabled
    // state when we're dealing with a tab as a whole or its root frame.
    const isTabOrRootFrame = typeof frameId === 'undefined' || frameId === 0;

    // The content script was unloaded but it's possible we still have activeTab
    // privileges for this tab. For example, some versions of Chrome and Safari
    // grant activeTab privileges to subsequent navigations to the same origin.
    //
    // Try to re-inject our content script and see if it works.
    let enabled = false;
    try {
      await this.injectScript(tabId, frameId);
      enabled = true;
    } catch (e) {
      // We got an error. If we're not dealing with the tab / root frame there's
      // nothing left to do.
      if (!isTabOrRootFrame) {
        return;
      }

      // Next, check if the tab still exists. Perhaps it finished unloading
      // while we were injecting scripts.
      if (!this.enabledTabs.some((t) => t.id === tabId)) {
        return;
      }

      // Drop the tab from our list of enabled tabs
      this.enabledTabs = this.enabledTabs.filter((t) => t.id !== tabId);
    }

    // Note that even if we successfully re-injected our content script
    // we still need to notify listeners because browsers will generally
    // automatically reset the browser action icon.
    if (isTabOrRootFrame) {
      this.notifyListeners(enabled, tabId);
    }
  }

  //
  // Config updates
  //

  async updateConfig(config: ContentConfig) {
    // Ignore redundant changes
    if (JSON.stringify(this.config) === JSON.stringify(config)) {
      return;
    }

    this.config = config;

    for (const tab of this.enabledTabs.slice()) {
      try {
        // We deliberately omit the 'id' member here since it's only needed
        // when setting up a port and shouldn't be required when we're just
        // updating the config.
        await browser.tabs.sendMessage(tab.id, { type: 'enable', config });
      } catch (e) {
        console.error(e);
        Bugsnag.notify(e);
      }
    }
  }

  //
  // Listeners
  //

  addListener(listener: EnabledChangedCallback) {
    if (!this.listeners.includes(listener)) {
      this.listeners.push(listener);
    }
  }

  removeListener(listener: EnabledChangedCallback) {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  private notifyListeners(enabled: boolean, tabId: number) {
    for (const listener of this.listeners.slice()) {
      listener(enabled, tabId);
    }
  }
}
