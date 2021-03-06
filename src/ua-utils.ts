export function isFirefox(): boolean {
  return navigator.userAgent.indexOf('Firefox/') !== -1;
}

export function isChromium(): boolean {
  return (
    navigator.userAgent.indexOf('Chrome/') !== -1 ||
    navigator.userAgent.indexOf('Chromium/') !== -1
  );
}

export function isEdge(): boolean {
  return navigator.userAgent.indexOf('Edg/') !== -1;
}

export function isSafari(): boolean {
  return navigator.userAgent.indexOf('Safari/') !== -1 && !isChromium();
}

export function isMac(): boolean {
  return /^Mac/i.test(navigator.platform);
}
