// File upload security (Ф12 12.B6, ADR-027), local storage driver:
//   - local links are signed like S3 presigned URLs: no signature, a forged one,
//     another key or an expired link → 403; a guest who saw a download link
//     cannot overwrite the file through it;
//   - an upload link writes one new object of at most the declared size;
//   - executables are refused by name at registration and by content at upload,
//     a known format must match its extension;
//   - downloads go out as attachment + octet-stream + nosniff;
//   - the file policy itself (unit).

import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const UPLOAD_DIR = path.join(tmpdir(), `tm-filesec-test-${Date.now()}`);
process.env.LOCAL_STORAGE_DIR = UPLOAD_DIR;

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { LocalStorageDriver } from '../src/lib/storage.js';
import { AppError } from '../src/lib/errors.js';
import { assertAllowedFileName, assertFileContent, extensionOf } from '../src/lib/file-policy.js';

const TS = Date.now();
const OWNER = `fsec-owner-${TS}@example.com`;
const GUEST = `fsec-guest-${TS}@example.com`;
const PW = 'Password123!';

const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj');
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(30, 0x90)]);

let app: FastifyInstance;
let ownerToken: string;
let guestToken: string;
let slug: string;
let projectId: string;
let issueId: string;

const auth = (token: string): [string, string] => ['Authorization', `Bearer ${token}`];
const issueBase = () =>
  `/api/v1/workspaces/${slug}/projects/${projectId}/issues/${issueId}/attachments`;
const toPath = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');

async function register(fileName: string, size: number, mime = 'application/pdf') {
  return request(app.server)
    .post(`${issueBase()}/`)
    .set(...auth(ownerToken))
    .send({ file_name: fileName, file_size: size, mime_type: mime });
}

async function put(url: string, bytes: Buffer, mime = 'application/pdf') {
  return request(app.server).put(url).set('content-type', mime).send(bytes);
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const reg = async (email: string) =>
    (
      await request(app.server)
        .post('/api/v1/auth/register')
        .send({ email, password: PW, display_name: email })
    ).body.access_token as string;
  ownerToken = await reg(OWNER);
  guestToken = await reg(GUEST);
  const guestId = (
    await request(app.server)
      .get('/api/v1/auth/me')
      .set(...auth(guestToken))
  ).body.id;

  slug = `fsec-${TS}`;
  await request(app.server)
    .post('/api/v1/workspaces')
    .set(...auth(ownerToken))
    .send({ name: 'Files', slug });
  await request(app.server)
    .post(`/api/v1/workspaces/${slug}/members`)
    .set(...auth(ownerToken))
    .send({ user_id: guestId, role: 'guest' });
  const project = await request(app.server)
    .post(`/api/v1/workspaces/${slug}/projects`)
    .set(...auth(ownerToken))
    .send({ name: 'Files', identifier: 'FSEC' });
  projectId = project.body.id;
  const states = await request(app.server)
    .get(`/api/v1/workspaces/${slug}/projects/${projectId}/states`)
    .set(...auth(ownerToken));
  const issue = await request(app.server)
    .post(`/api/v1/workspaces/${slug}/projects/${projectId}/issues`)
    .set(...auth(ownerToken))
    .send({ title: 'Отчёт', state_id: states.body[0].id });
  issueId = issue.body.id;
});

afterAll(async () => {
  await app.prisma.workspace.deleteMany({ where: { slug } });
  await app.prisma.user.deleteMany({ where: { email: { in: [OWNER, GUEST] } } });
  await app.close();
  await rm(UPLOAD_DIR, { recursive: true, force: true });
});

describe('signed local links', () => {
  it('an upload link carries an expiry, a size limit and a signature', async () => {
    const res = await register('Отчёт.pdf', PDF.length);
    expect(res.status).toBe(201);
    const url = new URL(res.body.upload.url);
    expect(url.searchParams.get('max')).toBe(String(PDF.length));
    expect(Number(url.searchParams.get('exp'))).toBeGreaterThan(Date.now() / 1000);
    expect(url.searchParams.get('sig')).toMatch(/^[\w-]{43}$/);
  });

  it('refuses an upload without a signature, with a forged one or to another key', async () => {
    const res = await register('Отчёт.pdf', PDF.length);
    const url = new URL(res.body.upload.url);

    expect((await put(url.pathname, PDF)).status).toBe(403);

    const forged = new URL(url);
    forged.searchParams.set('sig', 'A'.repeat(43));
    expect((await put(forged.pathname + forged.search, PDF)).status).toBe(403);

    // A bigger limit is not ours to grant.
    const bigger = new URL(url);
    bigger.searchParams.set('max', String(50 * 1024 * 1024));
    expect((await put(bigger.pathname + bigger.search, PDF)).status).toBe(403);

    // The same signature on another key is worthless.
    const other = url.pathname.replace(/__.*$/, '__other.pdf') + url.search;
    expect((await put(other, PDF)).status).toBe(403);

    expect((await put(url.pathname + url.search, PDF)).status).toBe(204);
  });

  it('an expired link is refused', async () => {
    const driver = app.storage as LocalStorageDriver;
    const key = `attachments/x/y/${TS}__late.pdf`;
    const slot = await driver.presignUpload(key, 'application/pdf', 100);
    const url = new URL(slot.url);
    const query = Object.fromEntries(url.searchParams) as Record<string, string>;
    // Valid now, refused once its time has passed.
    expect(typeof driver.verifyLink('PUT', key, query)).toBe('object');
    expect(driver.verifyLink('PUT', key, query, (Number(query.exp) + 1) * 1000)).toBe('expired');
  });

  it('an upload link is good for one upload, and not for more than declared', async () => {
    const res = await register('Акт.pdf', PDF.length);
    const url = toPath(res.body.upload.url);
    expect((await put(url, Buffer.concat([PDF, Buffer.from('extra bytes')]))).status).toBe(413);
    expect((await put(url, PDF)).status).toBe(204);
    const again = await put(url, PDF);
    expect(again.status).toBe(409);
  });

  it('a guest who saw the download link cannot overwrite the file', async () => {
    const res = await register('Отчёт кафедры.pdf', PDF.length);
    expect((await put(toPath(res.body.upload.url), PDF)).status).toBe(204);

    const list = await request(app.server)
      .get(`${issueBase()}/`)
      .set(...auth(guestToken));
    expect(list.status).toBe(200);
    const link = new URL(
      list.body.find((a: { id: string }) => a.id === res.body.attachment.id).download_url,
    );
    // The download link does not work for uploads, with or without its query.
    expect((await put(link.pathname + link.search, EXE)).status).toBe(403);
    expect((await put(link.pathname, EXE)).status).toBe(403);

    const download = await request(app.server).get(link.pathname + link.search);
    expect(download.status).toBe(200);
    expect(Buffer.from(download.body).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('downloads need the signed link and are served as a saved attachment', async () => {
    const res = await register('Справка.pdf', PDF.length);
    await put(toPath(res.body.upload.url), PDF);
    const list = await request(app.server)
      .get(`${issueBase()}/`)
      .set(...auth(ownerToken));
    const link = new URL(
      list.body.find((a: { id: string }) => a.id === res.body.attachment.id).download_url,
    );
    // Long enough for an open task (a day by default), unlike the 15-minute upload slot.
    expect(Number(link.searchParams.get('exp'))).toBeGreaterThan(Date.now() / 1000 + 3600);

    expect((await request(app.server).get(link.pathname)).status).toBe(403);
    const renamed = new URL(link);
    renamed.searchParams.set('name', 'evil.html');
    expect((await request(app.server).get(renamed.pathname + renamed.search)).status).toBe(403);

    const ok = await request(app.server).get(link.pathname + link.search);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('application/octet-stream');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.headers['content-disposition']).toMatch(/^attachment;/);
  });
});

describe('file policy at registration and upload', () => {
  it('refuses programs and scripts by name (400 FILE_TYPE_NOT_ALLOWED), nothing is created', async () => {
    for (const name of ['setup.exe', 'отчёт.pdf.exe', 'run.BAT', 'macro.xlsm', 'script.ps1 ']) {
      const res = await register(name, 10, 'application/octet-stream');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
    }
    expect(
      await app.prisma.attachment.count({
        where: { issue_id: issueId, file_name: { endsWith: 'exe' } },
      }),
    ).toBe(0);
  });

  it('refuses a program renamed to .pdf by its content, the file never reaches the disk', async () => {
    const res = await register('Отчёт.pdf', EXE.length);
    expect(res.status).toBe(201);
    const up = await put(toPath(res.body.upload.url), EXE);
    expect(up.status).toBe(400);
    expect(up.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
    expect(await app.storage.inspect(res.body.attachment.storage_key, 0)).toBeNull();
  });

  it('refuses a «pdf» that is not a PDF (FILE_CONTENT_MISMATCH), lets text files through', async () => {
    const notPdf = Buffer.from('just a text!');
    const fake = await register('Отчёт.pdf', notPdf.length);
    const bad = await put(toPath(fake.body.upload.url), notPdf);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('FILE_CONTENT_MISMATCH');

    const csv = Buffer.from('ФИО;Кафедра\n');
    const text = await register('Список.csv', csv.length, 'text/csv');
    expect((await put(toPath(text.body.upload.url), csv, 'text/csv')).status).toBe(204);

    const script = Buffer.from('#!/bin/sh\nrm -rf /');
    const disguised = await register('readme.txt', script.length, 'text/plain');
    const refused = await put(toPath(disguised.body.upload.url), script, 'text/plain');
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
  });
});

describe('file policy (unit)', () => {
  const code = (fn: () => void) => {
    try {
      fn();
      return null;
    } catch (err) {
      return err instanceof AppError ? err.code : 'other';
    }
  };
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]);
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

  it('takes the last extension, case- and trailing-dot-insensitive', () => {
    expect(extensionOf('Отчёт.PDF')).toBe('pdf');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('setup.exe.')).toBe('exe');
    expect(extensionOf('README')).toBe('');
    expect(extensionOf('.bashrc')).toBe('');
  });

  it('known formats must match, Office documents included', () => {
    expect(code(() => assertFileContent('План.docx', zip))).toBeNull();
    expect(code(() => assertFileContent('Реестр.xlsx', zip))).toBeNull();
    expect(code(() => assertFileContent('Старый.doc', ole))).toBeNull();
    expect(code(() => assertFileContent('Реестр.xlsx', PDF))).toBe('FILE_CONTENT_MISMATCH');
    expect(
      code(() => assertFileContent('Фото.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))),
    ).toBeNull();
    expect(code(() => assertFileContent('Фото.png', Buffer.from([0xff, 0xd8, 0xff])))).toBe(
      'FILE_CONTENT_MISMATCH',
    );
    expect(code(() => assertFileContent('empty.pdf', Buffer.alloc(0)))).toBe(
      'FILE_CONTENT_MISMATCH',
    );
    expect(code(() => assertFileContent('empty.txt', Buffer.alloc(0)))).toBeNull();
  });

  it('executables are refused whatever they are called', () => {
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
    const macho = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]);
    for (const head of [EXE, elf, macho, Buffer.from('#!/usr/bin/env node')]) {
      expect(code(() => assertFileContent('photo.dat', head))).toBe('FILE_TYPE_NOT_ALLOWED');
    }
    expect(code(() => assertAllowedFileName('Протокол.pdf'))).toBeNull();
    expect(code(() => assertAllowedFileName('Протокол.pdf.lnk'))).toBe('FILE_TYPE_NOT_ALLOWED');
  });
});
