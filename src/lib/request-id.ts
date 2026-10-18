// Request ids (Ф12 12.B9). Every request gets one: it is on every log line of the
// request (`reqId`), in the `X-Request-Id` response header and in the details of a
// 500. A problem a user reports with that code is found in the logs at once. A
// well-formed id sent by the proxy or the caller is kept, so one id follows the
// request through every hop; anything else is replaced by a fresh UUID.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Letters, digits and `._:-`, 8–128 chars: no spaces or control chars reach the logs. */
const WELL_FORMED = /^[A-Za-z0-9._:-]{8,128}$/;

export function requestId(req: IncomingMessage): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  return typeof incoming === 'string' && WELL_FORMED.test(incoming) ? incoming : randomUUID();
}
