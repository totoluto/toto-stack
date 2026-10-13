import {BackgroundService} from "@server/libs/background/BackgroundService";

export class BackgroundServiceManager {
    private readonly started: BackgroundService[] = [];

    constructor(private readonly services: BackgroundService[]) {}

    /** Starts services in order. If one fails, the error propagates; the ones already started are stopped by stopAll(). */
    public async startAll(): Promise<void> {
        for (const service of this.services) {
            if (this.started.includes(service)) continue;
            await service.start();
            this.started.push(service);
        }
    }

    /**
     * Stops the started services in reverse order. Keeps going when a service
     * fails and rethrows all failures together (AggregateError) at the end.
     */
    public async stopAll(): Promise<void> {
        const errors: Error[] = [];

        while (this.started.length > 0) {
            const service = this.started.pop()!;
            try {
                await service.stop();
            } catch (err) {
                errors.push(new Error(`Background service "${service.name}" failed to stop: ${err instanceof Error ? err.message : String(err)}`, {cause: err}));
            }
        }

        if (errors.length > 0) {
            throw new AggregateError(errors, `${errors.length} background service(s) failed to stop`);
        }
    }
}
