// Email transport abstraction.
//
// The single seam every feature uses to send mail (OTP codes, workspace invites).
// Dev/test with no SMTP_HOST configured logs a readable stub to stdout so codes
// and links are visible without a mail server. When SMTP_HOST is set — always the
// case in production — mail is delivered via an SMTP transport (nodemailer),
// entirely behind env (see config/env.ts). No provider details leak to callers.

import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config/index.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

let cachedTransport: Transporter | null = null;

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
 * Send an email. Uses SMTP when configured (`SMTP_HOST`); otherwise, in non-prod,
 * logs a stub to the console. Production without SMTP configured throws.
 */
export async function sendMail(message: MailMessage): Promise<void> {
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
