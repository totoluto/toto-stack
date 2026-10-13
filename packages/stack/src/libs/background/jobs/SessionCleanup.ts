import {StackPrismaClient} from "@server/libs/prisma/StackPrismaClient";
import {CronJob} from "@server/libs/background/CronService";

export type SessionCleanupOptions = {
    /** Rows deleted per statement. Default: 1000. */
    batchSize?: number;
    /** Max batches per run; a larger backlog continues on the next run. Default: 100. */
    maxBatches?: number;
};

/**
 * Deletes expired session rows every 15 minutes, in batches, so a large
 * backlog never becomes one long, table-locking DELETE. Pending MFA logins
 * and setups live in session rows that expire with them, so they are
 * removed here too (nothing else persists them).
 */
export class SessionCleanup implements CronJob {
    public readonly name = "SessionCleanup";
    public readonly cronExpression = "*/15 * * * *";

    private readonly batchSize: number;
    private readonly maxBatches: number;

    constructor(private readonly prisma: StackPrismaClient, options: SessionCleanupOptions = {}) {
        this.batchSize = options.batchSize ?? 1000;
        this.maxBatches = options.maxBatches ?? 100;
    }

    public async run(): Promise<void> {
        await this.deleteExpired();
    }

    /** Deletes expired rows (at most batchSize × maxBatches) and returns how many were deleted. */
    public async deleteExpired(): Promise<number> {
        const now = new Date(Date.now());
        let deleted = 0;

        for (let batch = 0; batch < this.maxBatches; batch++) {
            const expired = await this.prisma.session.findMany({
                where: {expiresAt: {lt: now}},
                select: {id: true},
                take: this.batchSize,
            });

            if (expired.length === 0) {
                break;
            }

            const {count} = await this.prisma.session.deleteMany({where: {id: {in: expired.map(row => row.id)}}});
            deleted += count;

            if (expired.length < this.batchSize) {
                break;
            }
        }

        return deleted;
    }
}
