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
  | 'INTERNAL_ERROR';

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
