/**
 * A long-running service started after the server listens and stopped on
 * shutdown (in reverse order). Release every timer/socket in stop().
 */
export interface BackgroundService {
    readonly name: string;
    start(): Promise<void> | void;
    stop(): Promise<void> | void;
}
