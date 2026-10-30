/**
 * Errors the domain layer throws on purpose. Each carries the HTTP status its
 * front ends should answer with and a message fit to show the person (or agent)
 * who caused it; anything else that escapes is a bug, logged and answered with
 * a generic 500.
 */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

/** Bad input. The message says what to change. */
export class UserInputError extends DomainError {
  constructor(message: string) {
    super(message, 400);
    this.name = "UserInputError";
  }
}

/** Nobody is signed in, or the token is no good. */
export class UnauthorizedError extends DomainError {
  constructor(message = "Sign in first.") {
    super(message, 401);
    this.name = "UnauthorizedError";
  }
}

/** Known actor, not allowed. Only used where the task is already visible to them. */
export class ForbiddenError extends DomainError {
  constructor(message = "You can't do that.") {
    super(message, 403);
    this.name = "ForbiddenError";
  }
}

/**
 * Doesn't exist, or the actor can't know whether it does. Private tasks answer
 * this, never 403, so their existence doesn't leak.
 */
export class NotFoundError extends DomainError {
  constructor(message = "That task doesn't exist, or you can't see it.") {
    super(message, 404);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, 409);
    this.name = "ConflictError";
  }
}

export class RateLimitedError extends DomainError {
  constructor(readonly retryAfterSeconds: number) {
    super("Too many changes at once. Wait a moment and try again.", 429);
    this.name = "RateLimitedError";
  }
}
