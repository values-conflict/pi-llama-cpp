/** The possible statuses of llama-server models */
export enum Status {
  LOADED = "loaded",
  LOADING = "loading",
  FAILED = "failed",
  SLEEPING = "sleeping",
  UNLOADED = "unloaded",
  UNAUTHORIZED = "unauthorized",
}

/** Terminal states that end a loading operation */
export const TERMINAL_STATUSES: Status[] = [
  Status.LOADED,
  Status.UNLOADED,
  Status.FAILED,
];
