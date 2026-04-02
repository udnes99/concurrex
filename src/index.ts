export {
    Executor,
    DebounceMode,
    type PoolOptions,
    type RegulatorState,
    type TaskRunOptions,
    type TaskRunDebouncedOptions,
} from "./Executor.js";

export type { Logger } from "./logger.js";

export {
    ConcurrexError,
    ResourceExhaustedError,
    ArgumentError,
    ExecutorNotRunningError,
} from "./errors.js";
