/** Base error for all Concurrex errors. */
export class ConcurrexError extends Error {
    constructor(message: string) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** Thrown when a task is rejected due to overload (ProDel drop, early shed, or per-lane shed). */
export class ResourceExhaustedError extends ConcurrexError {
    public readonly details?: Record<string, unknown>;

    constructor(message = "The resource has been exhausted", details?: Record<string, unknown>) {
        super(message);
        this.details = details;
    }
}

/** Thrown for invalid configuration (duplicate pool, bad parameters). */
export class ArgumentError extends ConcurrexError {
    constructor(message: string) {
        super(message);
    }
}

/** Thrown when run() is called after stop(). */
export class ExecutorNotRunningError extends ConcurrexError {
    constructor() {
        super("The executor is not running.");
    }
}
