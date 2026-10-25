// The computer service's entry point inside the SDK (#889): the core imports it only through this
// file. index.ts stays the public package export.
export {
  activityHeartbeatMs,
  type ComputerApi,
  computerBlobKey,
  type ComputerHandle,
  computerIdleMs,
  ComputerOperationError,
  computerProvider,
  ComputerUnavailableError,
  computerUserDelete,
  createComputer,
  defaultCommandTimeoutMs,
  type FileOperationOptions,
  maxScreens,
  type Rebuild,
  type ScreenControl,
  ScreenNotOpenError,
  syncCapBytes,
} from "./plugin";
export {
  type CommandResult,
  type ComputerProvider,
  type FileEntry,
  SandboxGoneError,
  type TimedOutCommand,
} from "./provider";
