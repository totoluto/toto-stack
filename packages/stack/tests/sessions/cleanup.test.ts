import {beforeEach, describe, expect, it, vi} from "vitest";
import {SessionCleanup} from "@server/libs/background/jobs/SessionCleanup";
import {advanceClock, agentFor, completeSetup, postJson} from "../helpers";
import {countedServer, countingPrisma, fakePrisma, HOUR, MINUTE, resetFakeDb, sessionRows} from "./support";

async function insertSessions(count: number, expiresInMs: number, prefix: string) {
    for (let i = 0; i < count; i++) {
        await fakePrisma.session.create({
            data: {
                id: `${prefix}-${i}`,
                data: {cookie: {originalMaxAge: null}},
                userId: null,
                ipAddress: null,
                userAgent: null,
                createdAt: new Date(Date.now()),
                lastSeenAt: new Date(Date.now()),
                expiresAt: new Date(Date.now() + expiresInMs),
            },
        });
    }
}

beforeEach(() => {
    resetFakeDb();
});

describe("SessionCleanup", () => {
    it("deletes expired rows in batches and keeps valid ones", async () => {
        await insertSessions(2500, -MINUTE, "expired");
        await insertSessions(10, HOUR, "valid");
        const counter = countingPrisma();
        const deleteMany = vi.spyOn(fakePrisma.session, "deleteMany");

        try {
            const deleted = await new SessionCleanup(counter.prisma, {batchSize: 1000}).deleteExpired();
            expect(deleted).toBe(2500);
            expect(counter.calls).toEqual([
                "session.findMany", "session.deleteMany",
                "session.findMany", "session.deleteMany",
                "session.findMany", "session.deleteMany",
            ]);
            const batchSizes = deleteMany.mock.calls.map(([args]) => (args.where.id as {in: string[]}).in.length);
            expect(batchSizes).toEqual([1000, 1000, 500]);
        } finally {
            deleteMany.mockRestore();
        }

        expect((await sessionRows()).map(row => row.id).sort()).toEqual(Array.from({length: 10}, (_, i) => `valid-${i}`).sort());
    });

    it("bounds the work per run; the rest goes on the next run", async () => {
        await insertSessions(25, -MINUTE, "expired");
        const job = new SessionCleanup(fakePrisma, {batchSize: 10, maxBatches: 2});

        expect(await job.deleteExpired()).toBe(20);
        expect(await sessionRows()).toHaveLength(5);
        await job.run();
        expect(await sessionRows()).toHaveLength(0);
    });

    it("removes expired pending MFA logins (no other persistent pending state exists)", async () => {
        const {app} = await countedServer();
        const owner = agentFor(app);
        await completeSetup(owner, "owner", "owner-password-123");
        await postJson(agentFor(app), "/api/auth/login", {username: "owner", password: "owner-password-123"});

        const pending = (await sessionRows()).filter(row => row.userId === null);
        expect(pending).toHaveLength(1);

        advanceClock(11 * MINUTE);
        await new SessionCleanup(fakePrisma).run();
        expect((await sessionRows()).filter(row => row.userId === null)).toEqual([]);
        expect((await sessionRows()).filter(row => row.userId === 1)).toHaveLength(1);
    });
});
