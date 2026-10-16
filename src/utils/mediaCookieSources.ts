export type BrowserCookieSourceOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export const isMediaCookieSourceSupported = (source: string, platform: string): boolean =>
  source !== 'safari' || platform === 'macos';

const browserCookieSourceOptions: readonly BrowserCookieSourceOption[] = [
  { value: 'none', label: 'None' },
  { value: 'safari', label: 'safariMacos' },
  { value: 'chrome', label: 'Chrome' },
  { value: 'chromium', label: 'Chromium' },
  { value: 'firefox', label: 'Firefox' },
  { value: 'edge', label: 'Edge' },
  { value: 'brave', label: 'Brave' },
  { value: 'opera', label: 'Opera' },
  { value: 'vivaldi', label: 'Vivaldi' },
  { value: 'whale', label: 'Whale' },
];

export const getBrowserCookieSourceOptions = (
  platform: string,
  selectedSource: string,
): BrowserCookieSourceOption[] => {
  const options = browserCookieSourceOptions
    .filter(option => isMediaCookieSourceSupported(option.value, platform))
    .map(option => ({ ...option }));

  if (selectedSource === 'safari' && !isMediaCookieSourceSupported('safari', platform)) {
    options.splice(1, 0, { value: 'safari', label: 'safariUnsupported', disabled: true });
  }

  return options;
};
