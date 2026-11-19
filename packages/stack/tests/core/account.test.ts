import crypto from "node:crypto";
import {describe, expect, it, vi} from "vitest";
import {UserService} from "@server/libs/services/UserService";
import {createFakePrisma} from "../fakePrisma";

const opaque = (id: string) => crypto.createHash("sha256").update(id).digest("base64url");

describe("account service", () => {
    it("reads explicit projections, preserves Dates and refreshes credential flags from the database", async () => {
        vi.useFakeTimers({toFake: ["Date"]});
        vi.setSystemTime(new Date("2026-11-19T12:00:00Z"));
        const prisma = createFakePrisma();
        const user = await prisma.user.create({data: {username: "alice", password: "private-password"}});
        await prisma.session.create({data: {id: "raw", userId: user.id, data: {secret: "private-session"}, expiresAt: new Date(Date.now() + 1000)}});
        await prisma.session.create({data: {id: "boundary", userId: user.id, data: {}, expiresAt: new Date()}});
        const service = new UserService(prisma);
        const start = prisma.$fake.calls.length;
        const first = await service.getAccount(user.id, "raw");
        expect(first.account).toEqual({id: user.id, username: "alice", roles: [], otpEnabled: false, apiKeyEnabled: false});
        expect(first.sessions).toHaveLength(1);
        expect(first.sessions[0]).toMatchObject({id: opaque("raw"), current: true, createdAt: expect.any(Date), lastSeenAt: expect.any(Date), expiresAt: expect.any(Date)});
        expect(prisma.$fake.calls.slice(start)).toEqual([
            {model: "user", operation: "findUniqueOrThrow", args: {where: {id: user.id}, select: {id: true, username: true, roles: {select: {role: {select: {name: true}}}}, otpEnabled: true, apiKey: true}}},
            {model: "session", operation: "findMany", args: {where: {userId: user.id, expiresAt: {gt: new Date().toISOString()}}, select: {id: true, ipAddress: true, userAgent: true, createdAt: true, lastSeenAt: true, expiresAt: true}, orderBy: {lastSeenAt: "desc"}}},
        ]);
        await prisma.user.update({where: {id: user.id}, data: {otpEnabled: true, apiKey: "stored-private-hash"}});
        expect((await service.getAccount(user.id, "raw")).account).toEqual({...first.account, otpEnabled: true, apiKeyEnabled: true});
        await prisma.user.update({where: {id: user.id}, data: {otpEnabled: false, apiKey: null}});
        expect((await service.getAccount(user.id, "raw")).account).toEqual(first.account);
    });

    it("keeps raw-ID revocation scoped to the caller including legacy expired sessions", async () => {
        const prisma = createFakePrisma();
        const user = await prisma.user.create({data: {username: "alice", password: "hash"}});
        const foreign = await prisma.user.create({data: {username: "bob", password: "hash"}});
        const row = {userId: user.id, data: {}, expiresAt: new Date(Date.now() - 1000)};
        await prisma.session.create({data: {...row, id: "legacy"}});
        await prisma.session.create({data: {...row, id: "foreign", userId: foreign.id}});
        const service = new UserService(prisma);
        await service.revokeSession(user.id, "foreign");
        expect(await prisma.session.findUnique({where: {id: "foreign"}})).not.toBeNull();
        await service.revokeSession(user.id, "legacy");
        expect(await prisma.session.findUnique({where: {id: "legacy"}})).toBeNull();
    });
    it("resolves opaque handles only among the caller's active sessions before scoped deletion", async () => {
        vi.useFakeTimers({toFake: ["Date"]});
        vi.setSystemTime(new Date("2026-11-19T12:00:00Z"));
        const prisma = createFakePrisma();
        const user = await prisma.user.create({data: {username: "alice", password: "hash"}});
        const foreign = await prisma.user.create({data: {username: "bob", password: "hash"}});
        const row = {userId: user.id, data: {secret: "not-needed"}, expiresAt: new Date(Date.now() + 60000)};
        await prisma.session.create({data: {...row, id: "own-raw"}});
        await prisma.session.create({data: {...row, id: "foreign-raw", userId: foreign.id}});
        await prisma.session.create({data: {...row, id: "expired-raw", expiresAt: new Date(Date.now() - 1)}});
        await prisma.session.create({data: {...row, id: "boundary-raw", expiresAt: new Date()}});
        const service = new UserService(prisma);
        await service.revokeSession(user.id, opaque("own-raw"));
        expect(await prisma.session.findUnique({where: {id: "own-raw"}})).toBeNull();
        for (const id of ["foreign-raw", "expired-raw", "boundary-raw", "missing"]) {
            await service.revokeSession(user.id, opaque(id));
        }
        expect((await prisma.session.findMany()).map(row => row.id).sort()).toEqual(["boundary-raw", "expired-raw", "foreign-raw"]);
    });
});
