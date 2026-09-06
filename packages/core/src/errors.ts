export type DomainErrorCode =
  | "not_found"
  | "conflict"
  | "validation"
  | "forbidden"
  | "unauthenticated"
  | "invalid_transition"
  | "tenant_mismatch"
  | "rate_limited";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: DomainErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    switch (this.code) {
      case "not_found":
        return 404;
      case "conflict":
        return 409;
      case "validation":
        return 400;
      case "forbidden":
      case "tenant_mismatch":
        return 403;
      case "unauthenticated":
        return 401;
      case "invalid_transition":
        return 409;
      case "rate_limited":
        return 429;
    }
  }
}

export const notFound = (entity: string, id?: string) =>
  new DomainError("not_found", id ? `${entity} ${id} not found` : `${entity} not found`, { entity, id });
export const conflict = (message: string, details?: Record<string, unknown>) => new DomainError("conflict", message, details);
export const validation = (message: string, details?: Record<string, unknown>) => new DomainError("validation", message, details);
export const forbidden = (message = "forbidden") => new DomainError("forbidden", message);
export const unauthenticated = (message = "authentication required") => new DomainError("unauthenticated", message);
export const invalidTransition = (entity: string, from: string, to: string) =>
  new DomainError("invalid_transition", `${entity} cannot move from ${from} to ${to}`, { entity, from, to });
