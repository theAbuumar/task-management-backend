// Security headers from helmet (1.B4) as the stands see them (13.D3, ADR-024):
// Swagger at /docs must load on the plain-http laptop stand, so the CSP may not
// carry `upgrade-insecure-requests` (it rewrote Swagger's scripts to https).

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('security headers', () => {
  it('Swagger UI page: CSP without upgrade-insecure-requests, still locked to self', async () => {
    const res = await request(app.server).get('/docs');
    expect(res.status).toBe(200);
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('API responses keep the rest of helmet (nosniff, frame-ancestors, HSTS)', async () => {
    const res = await request(app.server).get('/api/v1/auth/providers');
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'self'");
    expect(res.headers['strict-transport-security']).toContain('max-age=');
  });
});
