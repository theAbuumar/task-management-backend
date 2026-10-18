// A readable device label for «Мои сессии» (Ф12 12.B2): browser and OS from the
// User-Agent header. Deliberately small — the label helps a person recognise their
// own devices, it is not analytics. Unknown parts stay null; the raw header is
// returned next to it.

export interface DeviceInfo {
  /** «Chrome 128», «Firefox 131», «Safari 17»… */
  browser: string | null;
  /** «Windows», «macOS», «iOS», «Android», «Linux», «ChromeOS». */
  os: string | null;
  mobile: boolean;
}

// Order matters: Edge, Opera, Yandex and Samsung also announce «Chrome», Chrome
// announces «Safari».
const BROWSERS: [RegExp, string][] = [
  [/Edg(?:e|A|iOS)?\/(\d+)/, 'Edge'],
  [/(?:OPR|Opera)\/(\d+)/, 'Opera'],
  [/YaBrowser\/(\d+)/, 'Yandex Browser'],
  [/SamsungBrowser\/(\d+)/, 'Samsung Internet'],
  [/(?:Firefox|FxiOS)\/(\d+)/, 'Firefox'],
  [/(?:Chrome|CriOS)\/(\d+)/, 'Chrome'],
  [/Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//, 'Safari'],
];

const SYSTEMS: [RegExp, string][] = [
  [/Windows NT/, 'Windows'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux/, 'Linux'],
];

export function describeUserAgent(ua: string | null | undefined): DeviceInfo {
  if (!ua) return { browser: null, os: null, mobile: false };
  let browser: string | null = null;
  for (const [re, name] of BROWSERS) {
    const m = re.exec(ua);
    if (m) {
      browser = `${name} ${m[1]}`;
      break;
    }
  }
  const os = SYSTEMS.find(([re]) => re.test(ua))?.[1] ?? null;
  return { browser, os, mobile: /Mobi|Android|iPhone|iPad|iPod/.test(ua) };
}
