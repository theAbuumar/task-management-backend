// Where AI drafts come from (Ф11 11.B2): pasted text or a file of the meeting.
//
// - `.pdf`  — the model reads it itself (scans too), the bytes go as a document;
// - `.docx` — text extracted here with mammoth;
// - `.txt`  — UTF-8 text as is.
// Up to 10 MB. The same file rules as attachments apply (ADR-027): programs are
// refused by name and by content, and a known format must match its extension.

import mammoth from 'mammoth';
import { AppError } from '../../lib/errors.js';
import { assertFileContent, extensionOf } from '../../lib/file-policy.js';
import type { AiPart } from '../../lib/ai/provider.js';
import { dataBlock } from './prompts.js';

export const AI_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** About 50 pages of text; more than a protocol ever is. */
export const AI_TEXT_MAX_CHARS = 200_000;
const KINDS = new Set(['txt', 'docx', 'pdf']);

export interface SourceInput {
  text?: string | null;
  file?: { name: string; data: string } | null;
}

export interface Source {
  kind: 'text' | 'txt' | 'docx' | 'pdf';
  name: string | null;
  /** Characters of text read (null for a PDF the model reads itself). */
  chars: number | null;
  parts: AiPart[];
}

function unsupported(name: string, message: string): AppError {
  return new AppError(400, 'AI_FILE_UNSUPPORTED', message, { file_name: name });
}

function tooLarge(): AppError {
  return new AppError(413, 'AI_INPUT_TOO_LARGE', 'The text is too large for the AI service');
}

async function fileText(name: string, kind: string, bytes: Buffer): Promise<string> {
  if (kind === 'txt') {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '');
    if (text.includes('\uFFFD')) throw unsupported(name, 'The text file must be UTF-8');
    return text;
  }
  try {
    const { value } = await mammoth.extractRawText({ buffer: bytes });
    return value;
  } catch {
    throw unsupported(name, 'The Word document could not be read');
  }
}

/** Decode, check and read what the user gave; at least one of text or file. */
export async function readSource(input: SourceInput): Promise<Source> {
  const pasted = input.text?.trim() ?? '';
  if (!input.file) {
    if (!pasted) throw AppError.badRequest('Give the text of the document or a file');
    if (pasted.length > AI_TEXT_MAX_CHARS) throw tooLarge();
    return {
      kind: 'text',
      name: null,
      chars: pasted.length,
      parts: [
        { type: 'text', text: dataBlock('document', pasted, { source: 'вставленный текст' }) },
      ],
    };
  }

  const name = input.file.name.trim() || 'file';
  const kind = extensionOf(name);
  // Base64 is 4/3 of the bytes: refuse an oversized body before decoding it.
  if (input.file.data.length > Math.ceil((AI_FILE_MAX_BYTES * 4) / 3) + 4) throw tooLarge();
  const bytes = Buffer.from(input.file.data, 'base64');
  if (bytes.length === 0) throw unsupported(name, 'The file is empty');
  if (bytes.length > AI_FILE_MAX_BYTES) throw tooLarge();
  // Programs and disguised files are refused like attachments (ADR-027).
  assertFileContent(name, bytes.subarray(0, 16));
  if (!KINDS.has(kind)) throw unsupported(name, 'Only .txt, .docx and .pdf files are read');

  const extra: AiPart[] = pasted
    ? [{ type: 'text', text: dataBlock('document', pasted, { source: 'вставленный текст' }) }]
    : [];
  if (kind === 'pdf') {
    return {
      kind: 'pdf',
      name,
      chars: null,
      parts: [{ type: 'pdf', data: bytes, name }, ...extra],
    };
  }
  const text = (await fileText(name, kind, bytes)).trim();
  if (!text) throw unsupported(name, 'No text was found in the file');
  if (text.length + pasted.length > AI_TEXT_MAX_CHARS) throw tooLarge();
  return {
    kind: kind as 'txt' | 'docx',
    name,
    chars: text.length,
    parts: [{ type: 'text', text: dataBlock('document', text, { source: name }) }, ...extra],
  };
}
