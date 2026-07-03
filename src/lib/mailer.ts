// Email transport abstraction.
//
// The single seam every feature uses to send mail (OTP codes, workspace invites).
// Delivery is chosen at send time, in precedence order:
//   1. Resend HTTP API (RESEND_API_KEY, or a Resend SMTP_PASS) — plain HTTPS on
//      port 443, so it works on hosts (Render, Heroku, …) that throttle or block
//      outbound SMTP ports. This is the fast, reliable production path.
//   2. SMTP transport (nodemailer) when SMTP_HOST is set but no Resend key.
//   3. Console stub in dev/test with nothing configured, so codes stay visible.
// No provider details leak to callers.

import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config/index.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

let cachedTransport: Transporter | null = null;

/**
 * The Resend API key to use, if any: an explicit RESEND_API_KEY, or a Resend
 * SMTP_PASS (Resend's SMTP password *is* an API key) when SMTP points at Resend.
 */
function resolveResendKey(): string | undefined {
  if (config.RESEND_API_KEY) return config.RESEND_API_KEY;
  if (config.SMTP_HOST === 'smtp.resend.com' && config.SMTP_PASS) return config.SMTP_PASS;
  return undefined;
}

/** Send via Resend's HTTP API (HTTPS/443). Throws on a non-2xx response. */
async function sendViaResend(apiKey: string, message: MailMessage): Promise<void> {
  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: config.MAIL_FROM,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend API error ${res.status}: ${detail}`.trim());
  }
}

/** Lazily build (and cache) the SMTP transport from validated env. */
function getTransport(): Transporter {
  if (cachedTransport) return cachedTransport;
  if (!config.SMTP_HOST) {
    throw new Error('Email transport not configured: set SMTP_HOST (and related SMTP_* env vars).');
  }
  cachedTransport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
  });
  return cachedTransport;
}

function logStub(message: MailMessage): void {
  // eslint-disable-next-line no-console
  console.info(
    [
      '',
      '┌─ [EMAIL STUB] ──────────────────────────────────────────────',
      `│ To:      ${message.to}`,
      `│ From:    ${config.MAIL_FROM}`,
      `│ Subject: ${message.subject}`,
      '│',
      ...message.text.split('\n').map((line) => `│ ${line}`),
      '└─────────────────────────────────────────────────────────────',
      '',
    ].join('\n'),
  );
}

/**
 * Send an email. Prefers the Resend HTTP API (works where outbound SMTP is
 * blocked); falls back to SMTP when configured; otherwise, in non-prod, logs a
 * stub to the console. Production with nothing configured throws.
 */
export async function sendMail(message: MailMessage): Promise<void> {
  const resendKey = resolveResendKey();
  if (resendKey) {
    await sendViaResend(resendKey, message);
    return;
  }
  if (!config.SMTP_HOST && config.NODE_ENV !== 'production') {
    logStub(message);
    return;
  }
  await getTransport().sendMail({
    from: config.MAIL_FROM,
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
  });
}
