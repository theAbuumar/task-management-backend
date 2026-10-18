// Integration tests: issue attachments (local storage driver).
//
// Exercises the full presigned-URL flow end-to-end against the local disk
// driver: register an attachment (POST → metadata row + presigned PUT URL),
// upload bytes to that URL, download them back via the listed download URL, and
// delete. Also checks authorization (outsiders blocked; non-uploader members
// cannot delete) and that the attachment events land in the activity feed.

import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Point the local storage driver at a throwaway dir before app/config load.
const UPLOAD_DIR = path.join(tmpdir(), `tm-attach-test-${Date.now()}`);
process.env.LOCAL_STORAGE_DIR = UPLOAD_DIR;

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TS = Date.now();
const OWNER_EMAIL = `att-owner-${TS}@example.com`;
const MEMBER_EMAIL = `att-member-${TS}@example.com`;
const OUTSIDER_EMAIL = `att-outsider-${TS}@example.com`;
const PW = 'Password123!';

let app: FastifyInstance;
let ownerToken: string;
let memberToken: string;
let memberId: string;
let outsiderToken: string;
let workspaceSlug: string;
let projectId: string;
let issueId: string;

const auth = (token: string): [string, string] => ['Authorization', `Bearer ${token}`];
const base = () => `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}`;

// Strip the configured public base URL so a presigned local URL becomes an
// injectable app-relative path.
const toPath = (url: string): string => url.replace(/^https?:\/\/[^/]+/, '');

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  const reg = async (email: string): Promise<string> => {
    const res = await request(app.server)
      .post('/api/v1/auth/register')
      .send({ email, password: PW, display_name: email });
    return res.body.access_token as string;
  };
  ownerToken = await reg(OWNER_EMAIL);
  memberToken = await reg(MEMBER_EMAIL);
  outsiderToken = await reg(OUTSIDER_EMAIL);

  const memberMe = await request(app.server)
    .get('/api/v1/auth/me')
    .set(...auth(memberToken));
  memberId = memberMe.body.id;

  workspaceSlug = `att-ws-${TS}`;
  await request(app.server)
    .post('/api/v1/workspaces')
    .set(...auth(ownerToken))
    .send({ name: 'Attachment Workspace', slug: workspaceSlug });

  // Add the second user as a plain member.
  await request(app.server)
    .post(`/api/v1/workspaces/${workspaceSlug}/members`)
    .set(...auth(ownerToken))
    .send({ user_id: memberId, role: 'member' });

  const project = await request(app.server)
    .post(`/api/v1/workspaces/${workspaceSlug}/projects`)
    .set(...auth(ownerToken))
    .send({ name: 'Attachment Project', identifier: 'ATT' });
  projectId = project.body.id;

  const states = await request(app.server)
    .get(`${base()}/states`)
    .set(...auth(ownerToken));
  const issue = await request(app.server)
    .post(`${base()}/issues`)
    .set(...auth(ownerToken))
    .send({ title: 'Issue with files', state_id: states.body[0].id });
  issueId = issue.body.id;
});

afterAll(async () => {
  await app.prisma.workspace.deleteMany({ where: { slug: workspaceSlug } });
  await app.prisma.user.deleteMany({
    where: { email: { in: [OWNER_EMAIL, MEMBER_EMAIL, OUTSIDER_EMAIL] } },
  });
  await app.close();
  await rm(UPLOAD_DIR, { recursive: true, force: true });
});

describe('issue attachments', () => {
  it('registers an attachment and returns a presigned upload URL', async () => {
    const res = await request(app.server)
      .post(`${base()}/issues/${issueId}/attachments`)
      .set(...auth(ownerToken))
      .send({ file_name: 'notes.txt', file_size: 11, mime_type: 'text/plain' });

    expect(res.status).toBe(201);
    expect(res.body.attachment.file_name).toBe('notes.txt');
    expect(res.body.attachment.storage_key).toMatch(/^attachments\//);
    expect(res.body.upload.method).toBe('PUT');
    expect(res.body.upload.url).toContain('/internal/storage/');
  });

  it('completes the upload → download round trip', async () => {
    const reg = await request(app.server)
      .post(`${base()}/issues/${issueId}/attachments`)
      .set(...auth(ownerToken))
      .send({ file_name: 'hello.txt', file_size: 11, mime_type: 'text/plain' });

    // Upload bytes to the presigned URL.
    const put = await request(app.server)
      .put(toPath(reg.body.upload.url))
      .set('content-type', 'text/plain')
      .send('hello world');
    expect(put.status).toBe(204);

    // The download URL from the list should return the same bytes.
    const list = await request(app.server)
      .get(`${base()}/issues/${issueId}/attachments`)
      .set(...auth(ownerToken));
    const entry = (list.body as Array<{ id: string; download_url: string }>).find(
      (a) => a.id === reg.body.attachment.id,
    );
    expect(entry).toBeDefined();
    const download = await request(app.server)
      .get(toPath(entry!.download_url))
      .buffer(true)
      .parse((res, cb) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => cb(null, data));
      });
    expect(download.status).toBe(200);
    expect(download.body).toBe('hello world');
    expect(download.headers['content-disposition']).toContain('filename="hello.txt"');
  });

  it('downloads under the original (Cyrillic) file name and lists review_id + uploader ФИО', async () => {
    const name = 'Отчёт кафедры.pdf';
    const reg = await request(app.server)
      .post(`${base()}/issues/${issueId}/attachments`)
      .set(...auth(ownerToken))
      .send({ file_name: name, file_size: 8, mime_type: 'application/pdf' });
    await request(app.server)
      .put(toPath(reg.body.upload.url))
      .set('content-type', 'application/pdf')
      .send(Buffer.from('%PDF-1.7'));

    const list = await request(app.server)
      .get(`${base()}/issues/${issueId}/attachments`)
      .set(...auth(ownerToken));
    const entry = list.body.find((a: { id: string }) => a.id === reg.body.attachment.id);
    expect(entry.review_id).toBeNull();
    expect(entry.uploaded_by).toHaveProperty('last_name');

    const download = await request(app.server).get(toPath(entry.download_url));
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toContain(
      `filename*=UTF-8''${encodeURIComponent(name)}`,
    );
  });

  it('rejects a file larger than the configured maximum', async () => {
    const res = await request(app.server)
      .post(`${base()}/issues/${issueId}/attachments`)
      .set(...auth(ownerToken))
      .send({
        file_name: 'huge.bin',
        file_size: 999_999_999_999,
        mime_type: 'application/octet-stream',
      });
    expect(res.status).toBe(400);
  });

  it('records attachment events in the issue activity feed', async () => {
    const feed = await request(app.server)
      .get(`${base()}/issues/${issueId}/activity`)
      .set(...auth(ownerToken));
    const actions = (feed.body.data as Array<{ action: string }>).map((a) => a.action);
    expect(actions).toContain('issue.attachment_added');
  });

  it('forbids a non-uploader member from deleting another user’s attachment', async () => {
    const reg = await request(app.server)
      .post(`${base()}/issues/${issueId}/attachments`)
      .set(...auth(ownerToken))
      .send({ file_name: 'owned.txt', file_size: 3, mime_type: 'text/plain' });

    const res = await request(app.server)
      .delete(`${base()}/attachments/${reg.body.attachment.id}`)
      .set(...auth(memberToken));
    expect(res.status).toBe(403);
  });

  it('lets the uploader delete their own attachment', async () => {
    const reg = await request(app.server)
      .post(`${base()}/issues/${issueId}/attachments`)
      .set(...auth(ownerToken))
      .send({ file_name: 'temp.txt', file_size: 3, mime_type: 'text/plain' });

    const del = await request(app.server)
      .delete(`${base()}/attachments/${reg.body.attachment.id}`)
      .set(...auth(ownerToken));
    expect(del.status).toBe(204);

    const list = await request(app.server)
      .get(`${base()}/issues/${issueId}/attachments`)
      .set(...auth(ownerToken));
    const ids = (list.body as Array<{ id: string }>).map((a) => a.id);
    expect(ids).not.toContain(reg.body.attachment.id);
  });

  it('denies an outsider access to the attachment list', async () => {
    const res = await request(app.server)
      .get(`${base()}/issues/${issueId}/attachments`)
      .set(...auth(outsiderToken));
    expect(res.status).toBe(403);
  });
});
