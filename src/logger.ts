/** Logger interface accepted by the Executor. Any object with these methods works (e.g. console, pino, winston). */
export interface Logger {
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
    debug(message: string, data?: unknown): void;
}
