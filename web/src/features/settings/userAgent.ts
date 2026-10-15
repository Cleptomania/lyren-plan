// Human-readable device descriptions for the sessions list ("Firefox on Windows").
// Deliberately small: the common browsers and platforms, nothing else.

export type DeviceKind = 'desktop' | 'mobile' | 'tablet';

export interface DeviceInfo {
  browser: string | null;
  os: string | null;
  kind: DeviceKind;
  /** "Chrome on Android", "Safari on iOS", "curl", or "Unknown device". */
  label: string;
}

const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/(?:\b|Headless)(?:Chrome|CriOS|Chromium)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
  [/^curl\//i, 'curl'],
  [/^Wget\//i, 'Wget'],
];

const SYSTEMS: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:iPhone|iPod)\b/, 'iOS'],
  [/\biPad\b/, 'iPadOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

function firstMatch(ua: string, table: ReadonlyArray<[RegExp, string]>): string | null {
  return table.find(([re]) => re.test(ua))?.[1] ?? null;
}

export function describeUserAgent(ua: string | null | undefined): DeviceInfo {
  const text = (ua ?? '').trim();
  const browser = text ? firstMatch(text, BROWSERS) : null;
  const os = text ? firstMatch(text, SYSTEMS) : null;
  const kind: DeviceKind =
    /\biPad\b|\bTablet\b/.test(text) || (/\bAndroid\b/.test(text) && !/\bMobile\b/.test(text))
      ? 'tablet'
      : /\bMobile\b|\biPhone\b|\biPod\b/.test(text)
        ? 'mobile'
        : 'desktop';
  const label = browser && os ? `${browser} on ${os}` : (browser ?? os ?? 'Unknown device');
  return { browser, os, kind, label };
}
