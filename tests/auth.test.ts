// Integration tests for the auth flow.
//
// Runs against a live Postgres. Each test run uses a unique email prefix to
// avoid conflicts; all created rows are deleted in afterAll.

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const PREFIX = `test-${Date.now()}`;
const EMAIL = `${PREFIX}@example.com`;
const PASSWORD = 'Password123!';
const DISPLAY_NAME = 'Integration Tester';

let app: FastifyInstance;
let accessToken: string;
let refreshToken: string;
let userId: string;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  // Clean up test user and their tokens (cascade from FK).
  await app.prisma.refreshToken.deleteMany({ where: { user: { email: EMAIL } } });
  await app.prisma.user.deleteMany({ where: { email: EMAIL } });
  await app.close();
});

describe('auth flow', () => {
  it('registers a new user and returns token pair + user (no password_hash)', async () => {
    const res = await request(app.server)
      .post('/api/v1/auth/register')
      .send({ email: EMAIL, password: PASSWORD, display_name: DISPLAY_NAME });

    expect(res.status).toBe(201);
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.refresh_token).toBeTruthy();
    expect(res.body.user.email).toBe(EMAIL);
    expect(res.body.user.display_name).toBe(DISPLAY_NAME);
    expect(res.body.user).not.toHaveProperty('password_hash');

    accessToken = res.body.access_token;
    refreshToken = res.body.refresh_token;
    userId = res.body.user.id;
  });

  it('rejects duplicate registration with 409', async () => {
    const res = await request(app.server)
      .post('/api/v1/auth/register')
      .send({ email: EMAIL, password: PASSWORD, display_name: DISPLAY_NAME });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('logs in with correct credentials and returns a new token pair', async () => {
    const res = await request(app.server)
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.refresh_token).toBeTruthy();
  });

  it('rejects login with wrong password', async () => {
    const res = await request(app.server)
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: 'wrongpassword' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('GET /me returns the authenticated user', async () => {
    const res = await request(app.server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(userId);
    expect(res.body.email).toBe(EMAIL);
  });

  it('GET /me with no token returns 401', async () => {
    const res = await request(app.server).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('PATCH /me updates display_name', async () => {
    const res = await request(app.server)
      .patch('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ display_name: 'Updated Name' });

    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('Updated Name');
  });

  it('rotates the refresh token and issues a new pair', async () => {
    const res = await request(app.server)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.refresh_token).toBeTruthy();
    // Tokens should be different.
    expect(res.body.refresh_token).not.toBe(refreshToken);

    // Update for next test.
    refreshToken = res.body.refresh_token;
  });

  it('rejects a refresh token that has been rotated (single-use)', async () => {
    // The original refreshToken was rotated above, so it is now revoked.
    // Re-use the original (pre-rotation) token.
    const originalRefresh = refreshToken;
    // Rotate once more to make originalRefresh stale.
    const rotateRes = await request(app.server)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: originalRefresh });
    expect(rotateRes.status).toBe(200);
    const staledToken = originalRefresh;

    // Now try to use the staled token.
    const res = await request(app.server)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: staledToken });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('logout revokes the refresh token', async () => {
    // Log in fresh to get a clean token.
    const loginRes = await request(app.server)
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD });
    const freshToken = loginRes.body.refresh_token;

    await request(app.server)
      .post('/api/v1/auth/logout')
      .send({ refresh_token: freshToken })
      .expect(204);

    // Attempting to use the revoked token should fail.
    const res = await request(app.server)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: freshToken });
    expect(res.status).toBe(401);
  });
});
