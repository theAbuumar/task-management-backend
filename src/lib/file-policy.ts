// What files may be attached (Ф12 12.B6, ADR-027).
//
//   - executables and scripts are refused by name when the attachment is
//     registered, and by content (PE, ELF, Mach-O, `#!` scripts) whatever the name;
//   - a file of a known format must really be one: a «report.pdf» starts with %PDF,
//     an .xlsx is a zip, a .doc an OLE container — otherwise FILE_CONTENT_MISMATCH;
//   - text formats (.txt, .csv, …) and anything unknown are checked for executable
//     signatures only.
// Downloads are always `attachment` + octet-stream + nosniff (plugins/storage.ts),
// so even an allowed HTML or SVG file is saved, never rendered by the browser.

import { AppError } from './errors.js';

/** Programs, installers, scripts, shortcuts and macro-enabled Office files. */
// prettier-ignore
export const BLOCKED_EXTENSIONS = new Set([
  'exe', 'msi', 'msp', 'msc', 'com', 'scr', 'pif', 'cpl', 'dll', 'sys', 'drv', 'ocx',
  'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'mjs', 'wsf', 'wsh', 'hta',
  'jar', 'class', 'sh', 'bash', 'zsh', 'csh', 'ksh', 'command', 'run', 'bin', 'elf',
  'apk', 'appx', 'msix', 'app', 'dmg', 'pkg', 'deb', 'rpm', 'lnk', 'url', 'reg', 'inf',
  'iso', 'img', 'vhd', 'vhdx', 'gadget', 'application', 'xll', 'xlam', 'docm', 'xlsm',
  'pptm', 'dotm', 'xltm', 'potm', 'ppam', 'sldm',
]);

/** Leading bytes each known format must start with (any of the variants). */
const SIGNATURES: Record<string, Buffer[]> = (() => {
  const b = (...bytes: number[]) => Buffer.from(bytes);
  const s = (text: string) => Buffer.from(text, 'latin1');
  const zip = [b(0x50, 0x4b, 0x03, 0x04), b(0x50, 0x4b, 0x05, 0x06)];
  const ole = [b(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)];
  const jpeg = [b(0xff, 0xd8, 0xff)];
  return {
    pdf: [s('%PDF-')],
    png: [b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
    jpg: jpeg,
    jpeg,
    gif: [s('GIF87a'), s('GIF89a')],
    webp: [s('RIFF')],
    rtf: [s('{\\rtf')],
    zip,
    docx: zip,
    xlsx: zip,
    pptx: zip,
    odt: zip,
    ods: zip,
    odp: zip,
    doc: ole,
    xls: ole,
    ppt: ole,
  };
})();

/** Executables whatever they are called: Windows PE, ELF, Mach-O, scripts. */
function isExecutable(head: Buffer): boolean {
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return true; // MZ
  if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    return true; // \x7fELF
  }
  if (head.length >= 4) {
    const magic = head.readUInt32BE(0);
    // Mach-O 32/64 in both byte orders and fat binaries.
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)) {
      return true;
    }
  }
  return head.length >= 2 && head[0] === 0x23 && head[1] === 0x21; // #!
}

/** Lower-case extension of a file name ('' when there is none). */
export function extensionOf(fileName: string): string {
  const base = fileName.trim().replace(/[.\s]+$/, '');
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** How many leading bytes {@link assertFileContent} needs to see. */
export const SNIFF_BYTES = 16;

/** Refuse an executable or script by its name (registration of an attachment). */
export function assertAllowedFileName(fileName: string): void {
  if (BLOCKED_EXTENSIONS.has(extensionOf(fileName))) {
    throw new AppError(
      400,
      'FILE_TYPE_NOT_ALLOWED',
      'Executable files and scripts cannot be attached',
      { file_name: fileName },
    );
  }
}

/**
 * Check the bytes of a file named `fileName`: no executable content, and a known
 * format must carry its own signature. `head` is the file's first bytes.
 */
export function assertFileContent(fileName: string, head: Buffer): void {
  assertAllowedFileName(fileName);
  if (isExecutable(head)) {
    throw new AppError(
      400,
      'FILE_TYPE_NOT_ALLOWED',
      'The file is an executable program or script',
      { file_name: fileName },
    );
  }
  const expected = SIGNATURES[extensionOf(fileName)];
  if (
    expected &&
    !expected.some((sig) => head.length >= sig.length && head.subarray(0, sig.length).equals(sig))
  ) {
    throw new AppError(
      400,
      'FILE_CONTENT_MISMATCH',
      'The file content does not match its extension',
      { file_name: fileName },
    );
  }
}
