// Standardized application error. Thrown anywhere in services/controllers
// and translated into a consistent JSON response by the error handler.
export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly details?: unknown;
  // Optional stable, machine-readable code (e.g. "MAINTENANCE") that clients
  // can branch on independently of the human-readable message.
  public code?: string;

  constructor(statusCode: number, message: string, details?: unknown, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }

  /** Fluent helper to attach a machine-readable code. */
  withCode(code: string): this {
    this.code = code;
    return this;
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, message, details);
  }
  static unauthorized(message = "Unauthorized") {
    return new ApiError(401, message);
  }
  static forbidden(message = "Forbidden") {
    return new ApiError(403, message);
  }
  static notFound(message = "Resource not found") {
    return new ApiError(404, message);
  }
  static conflict(message: string, details?: unknown) {
    return new ApiError(409, message, details);
  }
  static tooManyRequests(message = "Too many requests") {
    return new ApiError(429, message);
  }
  static serviceUnavailable(message = "Service temporarily unavailable", details?: unknown) {
    return new ApiError(503, message, details);
  }
  static internal(message = "Internal server error") {
    return new ApiError(500, message, undefined, false);
  }
}
