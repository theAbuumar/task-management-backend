// Application error types.
//
// `AppError` is the single way services signal an expected failure (not found,
// forbidden, conflict, …). The centralized error handler
// (`src/plugins/error-handler.ts`) maps these to the TZ error envelope
// `{ error: { code, message, details } }` with the right HTTP status. Anything
// that is NOT an `AppError` is treated as an unexpected 500.

/** Stable, machine-readable error codes returned in the envelope `code` field. */
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'GONE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  // Specific codes for user-facing flows, so clients can show a precise,
  // localized message instead of the generic one for the HTTP status.
  | 'INVALID_CREDENTIALS'
  | 'EMAIL_NOT_VERIFIED'
  | 'ACCOUNT_DEACTIVATED'
  | 'NO_PASSWORD'
  | 'OTP_NOT_FOUND'
  | 'OTP_INVALID'
  | 'OTP_EXPIRED'
  | 'OTP_TOO_MANY_ATTEMPTS'
  | 'OWNER_CANNOT_LEAVE'
  | 'ALREADY_MEMBER'
  | 'INVITE_EXPIRED'
  | 'INVITE_ALREADY_ACCEPTED'
  | 'INVITE_EMAIL_MISMATCH'
  | 'DEPARTMENT_CYCLE'
  | 'REVIEW_REQUIRED'
  | 'REVIEW_PENDING'
  | 'NO_PENDING_REVIEW'
  | 'NO_REVIEW_STATE'
  | 'REPORT_REQUIRED'
  | 'NOT_REVIEWER'
  | 'NOT_ASSIGNEE'
  | 'DEADLINE_CHANGE_FORBIDDEN'
  | 'DEADLINE_REQUEST_PENDING'
  | 'DEPARTMENT_HAS_NO_HEAD'
  | 'REALTIME_UNAVAILABLE'
  | 'TELEGRAM_NOT_CONFIRMED';

/**
 * Catalog of every error code with its meaning — the contract clients translate
 * from (published in the OpenAPI description of the error envelope).
 */
export const ERROR_CODES: Record<ErrorCode, string> = {
  BAD_REQUEST: 'The request is malformed or breaks a business rule',
  VALIDATION_ERROR: 'Input failed schema validation (see details)',
  UNAUTHORIZED: 'Missing, invalid or expired credentials',
  FORBIDDEN: 'Authenticated, but not allowed to do this',
  NOT_FOUND: 'The resource does not exist or is not visible to you',
  CONFLICT: 'The request conflicts with the current state',
  GONE: 'The resource existed but is no longer available',
  RATE_LIMITED: 'Too many requests — retry later',
  INTERNAL_ERROR: 'Unexpected server error',
  INVALID_CREDENTIALS: 'Wrong email or password',
  EMAIL_NOT_VERIFIED: 'The email address has not been confirmed yet',
  ACCOUNT_DEACTIVATED: 'The account is deactivated',
  NO_PASSWORD: 'The account has no password — sign in another way',
  OTP_NOT_FOUND: 'No active verification code — request a new one',
  OTP_INVALID: 'The verification code is wrong',
  OTP_EXPIRED: 'The verification code has expired',
  OTP_TOO_MANY_ATTEMPTS: 'Too many wrong attempts — request a new code',
  OWNER_CANNOT_LEAVE: 'The workspace owner must transfer ownership before leaving',
  ALREADY_MEMBER: 'The user is already a member of the workspace',
  INVITE_EXPIRED: 'The invitation has expired',
  INVITE_ALREADY_ACCEPTED: 'The invitation has already been accepted',
  INVITE_EMAIL_MISMATCH: 'The invitation was sent to a different email address',
  DEPARTMENT_CYCLE: 'A department cannot be moved under itself or its own sub-department',
  REVIEW_REQUIRED: 'The assignment must be handed in for review; only its controller can close it',
  REVIEW_PENDING: 'The work is already waiting for review',
  NO_PENDING_REVIEW: 'There is no hand-in waiting for review',
  NO_REVIEW_STATE: 'The project has no "review" state to move the work into',
  REPORT_REQUIRED: 'A written report is required to hand the work in',
  NOT_REVIEWER: 'Only the controller (or the author) can accept or return this work',
  NOT_ASSIGNEE: 'Only an assignee of this issue can do this',
  DEADLINE_CHANGE_FORBIDDEN:
    'Only the controller can change this deadline — request a change instead',
  DEADLINE_REQUEST_PENDING: 'A deadline change request is already waiting for a decision',
  DEPARTMENT_HAS_NO_HEAD:
    'A department picked for a distribution has no head to assign it to (see details)',
  REALTIME_UNAVAILABLE: 'Live updates are temporarily unavailable — the client keeps retrying',
  TELEGRAM_NOT_CONFIRMED:
    'The Telegram link is not confirmed in the bot (details.status: pending — keep polling; expired or used — start again)',
};

/**
 * An expected, client-facing error. `message` is safe to return to the caller;
 * `details` carries optional structured context (e.g. field validation issues).
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(statusCode: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  // --- Convenience constructors for the common cases -------------------------

  static badRequest(message = 'Bad request', details?: unknown): AppError {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }

  static unauthorized(message = 'Authentication required', details?: unknown): AppError {
    return new AppError(401, 'UNAUTHORIZED', message, details);
  }

  static forbidden(
    message = 'You do not have access to this resource',
    details?: unknown,
  ): AppError {
    return new AppError(403, 'FORBIDDEN', message, details);
  }

  static notFound(message = 'Resource not found', details?: unknown): AppError {
    return new AppError(404, 'NOT_FOUND', message, details);
  }

  static conflict(message = 'Resource conflict', details?: unknown): AppError {
    return new AppError(409, 'CONFLICT', message, details);
  }

  static gone(message = 'Resource is no longer available', details?: unknown): AppError {
    return new AppError(410, 'GONE', message, details);
  }

  static rateLimited(message = 'Too many requests', details?: unknown): AppError {
    return new AppError(429, 'RATE_LIMITED', message, details);
  }
}

/** The shape every error response takes (TZ §8 error envelope). */
export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

/** Build the error envelope, omitting `details` when not provided. */
export function toEnvelope(code: ErrorCode, message: string, details?: unknown): ErrorEnvelope {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}
