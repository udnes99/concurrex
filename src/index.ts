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

export {
    type BaseSignal,
    type RegulatorSignal,
    type AdmissionSignal,
    type SignalContext,
    type RegulatorContext,
    type AdmitInfo,
    type CompletionInfo,
    type EvaluateInfo,
    type LatencyDriftState,
    type LaneErrorShedState,
    LatencyDrift,
    EarlyShed,
    LaneErrorShed,
} from "./signals.js";

export { Statistics } from "./statistics.js";
