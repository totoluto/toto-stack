import {describe, expect, it} from "vitest";
import fakePrisma, {createFakePrisma, FakeTransactionClient, resetFakeDb} from "../fakePrisma";

const rolesInclude = {roles: {include: {role: true}}} as const;

async function seed(prisma = createFakePrisma()) {
    await prisma.role.createMany({data: [{name: "owner"}, {name: "admin"}]});
    const user = await prisma.user.create({
        data: {username: "alice", password: "hash", apiKey: "key-hash", otpSecret: "SECRET", roles: {create: [{role: {connect: {name: "admin"}}}]}},
    });
    return {prisma, user};
}

const codeOf = (promise: Promise<unknown>) => promise.then(() => "ok", (err: {code?: string; name?: string}) => err.code ?? err.name);

describe("fakePrisma isolation (L38)", () => {
    it("gives every instance its own database", async () => {
        const {prisma: a} = await seed();
        const b = createFakePrisma();

        expect(await a.user.count()).toBe(1);
        expect(await b.user.count()).toBe(0);
        // The shared default instance is untouched as well
        expect(await fakePrisma.user.count()).toBe(0);
    });

    it("reset() empties tables, ids and the call log", async () => {
        const {prisma} = await seed();
        prisma.$fake.reset();

        expect(await prisma.user.count()).toBe(0);
        expect(prisma.$fake.calls).toHaveLength(1); // only the count above
        const {user} = await seed(prisma);
        expect(user.id).toBe(1);
    });

    it("resetFakeDb() resets the shared default instance", async () => {
        await seed(fakePrisma);
        resetFakeDb();
        expect(await fakePrisma.user.count()).toBe(0);
    });
});

describe("fakePrisma projection (H14)", () => {
    it("returns scalar columns only unless relations are included", async () => {
        const {prisma, user} = await seed();

        expect(user).not.toHaveProperty("roles");
        const found = await prisma.user.findUnique({where: {id: user.id}});
        expect(Object.keys(found!).sort()).toEqual(["apiKey", "createdAt", "id", "otpEnabled", "otpLastUsedStep", "otpSecret", "password", "updatedAt", "username"]);

        const withRoles = await prisma.user.findUnique({where: {id: user.id}, include: rolesInclude});
        expect(withRoles!.roles.map(userRole => userRole.role.name)).toEqual(["admin"]);
    });

    it("returns exactly the selected fields, so secrets aren't leaked by a select", async () => {
        const {prisma} = await seed();
        const [listed] = await prisma.user.findMany({select: {id: true, username: true, roles: {select: {role: {select: {name: true}}}}}});

        expect(listed).toEqual({id: 1, username: "alice", roles: [{role: {name: "admin"}}]});
    });

    it("rejects select together with include, and unknown fields", async () => {
        const {prisma} = await seed();

        expect(await codeOf(prisma.user.findFirst({select: {id: true}, include: {roles: true}}))).toBe("PrismaClientValidationError");
        expect(await codeOf(prisma.user.findFirst({select: {nope: true}}))).toBe("PrismaClientValidationError");
        expect(await codeOf(prisma.user.findFirst({where: {nope: 1}}))).toBe("PrismaClientValidationError");
        expect(await codeOf(prisma.user.findUnique({where: {otpEnabled: true}}))).toBe("PrismaClientValidationError");
    });

    it("returns copies; Json columns are stored serialized", async () => {
        const {prisma, user} = await seed();
        const data = {when: new Date(0), nested: {n: 1}};
        await prisma.session.create({data: {id: "s1", data, userId: user.id, expiresAt: new Date(Date.now() + 1000)}});
        data.nested.n = 2;

        const session = await prisma.session.findUnique({where: {id: "s1"}});
        expect(session!.data).toEqual({when: "1970-01-01T00:00:00.000Z", nested: {n: 1}});

        (session!.data as {nested: {n: number}}).nested.n = 3;
        expect((await prisma.session.findUnique({where: {id: "s1"}}))!.data).toEqual({when: "1970-01-01T00:00:00.000Z", nested: {n: 1}});
    });
});

describe("fakePrisma constraints like MariaDB (utf8mb4_unicode_ci)", () => {
    it("compares and indexes usernames case-insensitively", async () => {
        const {prisma} = await seed();

        expect(await codeOf(prisma.user.create({data: {username: "ALICE", password: "x"}}))).toBe("P2002");
        expect(await codeOf(prisma.user.create({data: {username: "alice ", password: "x"}}))).toBe("P2002");
        expect(await codeOf(prisma.user.create({data: {username: "alicé", password: "x"}}))).toBe("P2002");
        expect((await prisma.user.findFirst({where: {username: "Alice"}}))?.username).toBe("alice");
    });

    it("keeps apiKey unique while NULLs never collide", async () => {
        const {prisma} = await seed();

        expect(await codeOf(prisma.user.create({data: {username: "bob", password: "x", apiKey: "key-hash"}}))).toBe("P2002");
        await prisma.user.create({data: {username: "carol", password: "x", apiKey: null}});
        await prisma.user.create({data: {username: "dave", password: "x"}});
        expect(await prisma.user.count({where: {apiKey: null}})).toBe(2);
        const bob = await prisma.user.create({data: {username: "bob", password: "x"}});
        expect(await codeOf(prisma.user.update({where: {id: bob.id}, data: {apiKey: "KEY-HASH"}}))).toBe("P2002");
    });

    it("enforces VARCHAR lengths (P2000)", async () => {
        const {prisma} = await seed();
        const expiresAt = new Date(Date.now() + 1000);

        await prisma.session.create({data: {id: "ok", data: {}, userAgent: "u".repeat(512), expiresAt}});
        expect(await codeOf(prisma.session.create({data: {id: "long", data: {}, userAgent: "u".repeat(513), expiresAt}}))).toBe("P2000");
        expect(await codeOf(prisma.user.create({data: {username: "x".repeat(192), password: "x"}}))).toBe("P2000");
    });

    it("enforces foreign keys and cascades deletes", async () => {
        const {prisma, user} = await seed();
        const expiresAt = new Date(Date.now() + 1000);

        expect(await codeOf(prisma.session.create({data: {id: "orphan", data: {}, userId: 999, expiresAt}}))).toBe("P2003");
        await prisma.session.create({data: {id: "s1", data: {}, userId: user.id, expiresAt}});
        await prisma.session.create({data: {id: "anon", data: {}, expiresAt}});
        await prisma.setupLock.create({data: {id: 1, userId: user.id}});

        await prisma.user.delete({where: {id: user.id}});
        expect(await prisma.session.findMany({select: {id: true}})).toEqual([{id: "anon"}]);
        expect(await prisma.userRole.count()).toBe(0);
        expect(await prisma.setupLock.count()).toBe(0);
        expect(await prisma.role.count()).toBe(2);
    });

    it("reports missing records and failed nested connects (P2025) without partial writes", async () => {
        const {prisma} = await seed();

        expect(await codeOf(prisma.user.update({where: {id: 42}, data: {password: "y"}}))).toBe("P2025");
        expect(await codeOf(prisma.user.delete({where: {id: 42}}))).toBe("P2025");
        expect(await codeOf(prisma.user.create({data: {username: "eve", password: "x", roles: {create: [{role: {connect: {name: "ghost"}}}]}}}))).toBe("P2025");
        expect(await prisma.user.findFirst({where: {username: "eve"}})).toBeNull();
    });

    it("requires non-null columns and rejects wrong types", async () => {
        const prisma = createFakePrisma();

        expect(await codeOf(prisma.session.create({data: {id: "s", data: {}}}))).toBe("PrismaClientValidationError");
        expect(await codeOf(prisma.user.create({data: {username: "x", password: null}}))).toBe("PrismaClientValidationError");
        expect(await codeOf(prisma.user.create({data: {username: "x", password: "x", otpEnabled: "yes"}}))).toBe("PrismaClientValidationError");
    });

    it("throws for query shapes it doesn't emulate instead of ignoring them", async () => {
        const prisma = createFakePrisma();

        await expect(prisma.user.findMany({distinct: ["username"]})).rejects.toThrow(/not emulated/);
        await expect(prisma.$executeRaw()).rejects.toThrow(/not emulated/);
    });
});

describe("fakePrisma query semantics", () => {
    it("is lazy like PrismaPromise: un-awaited queries never run", async () => {
        const prisma = createFakePrisma();
        void prisma.user.create({data: {username: "ghost", password: "x"}});
        await new Promise(resolve => setTimeout(resolve, 5));

        expect(await prisma.user.count()).toBe(0);
    });

    it("supports SQL-style filters, ordering and paging", async () => {
        const prisma = createFakePrisma();
        for (const username of ["c", "a", "b"]) await prisma.user.create({data: {username, password: "x", otpLastUsedStep: username === "b" ? null : 5}});

        expect((await prisma.user.findMany({orderBy: {username: "desc"}, skip: 1, take: 1})).map(user => user.username)).toEqual(["b"]);
        // `not` and comparisons never match NULL columns
        expect(await prisma.user.count({where: {otpLastUsedStep: {not: 5}}})).toBe(0);
        expect(await prisma.user.count({where: {OR: [{otpLastUsedStep: null}, {otpLastUsedStep: {lt: 6}}]}})).toBe(3);
        expect(await prisma.user.count({where: {username: {in: ["A", "B"]}}})).toBe(2);
        expect(await prisma.user.count({where: {OR: []}})).toBe(0);
    });

    it("filters through relations", async () => {
        const {prisma} = await seed();
        await prisma.user.create({data: {username: "bob", password: "x"}});

        expect((await prisma.user.findMany({where: {roles: {some: {role: {name: "admin"}}}}})).map(user => user.username)).toEqual(["alice"]);
        expect((await prisma.user.findMany({where: {roles: {none: {}}}})).map(user => user.username)).toEqual(["bob"]);
    });
});

describe("fakePrisma transactions", () => {
    it("rolls back an interactive transaction's writes, keeping concurrent writes", async () => {
        const {prisma} = await seed();

        const failing = prisma.$transaction(async tx => {
            await tx.user.create({data: {username: "inside", password: "x"}});
            await tx.user.update({where: {id: 1}, data: {password: "changed"}});
            await new Promise(resolve => setTimeout(resolve, 10));
            throw new Error("abort");
        });
        await prisma.user.create({data: {username: "outside", password: "x"}});

        await expect(failing).rejects.toThrow("abort");
        expect((await prisma.user.findMany({orderBy: {id: "asc"}})).map(user => [user.username, user.password])).toEqual([["alice", "hash"], ["outside", "x"]]);
    });

    it("rolls back a batch transaction and refuses a closed transaction client", async () => {
        const {prisma} = await seed();

        await expect(prisma.$transaction([
            prisma.user.create({data: {username: "bob", password: "x"}}),
            prisma.user.create({data: {username: "BOB", password: "x"}}),
        ])).rejects.toMatchObject({code: "P2002"});
        expect(await prisma.user.count()).toBe(1);

        let leaked: FakeTransactionClient | undefined;
        await prisma.$transaction(async tx => void (leaked = tx));
        expect(await codeOf(leaked!.user.count())).toBe("P2028");
    });

    it("injects latency per call, so read-then-write races are reproducible", async () => {
        const prisma = createFakePrisma({latency: ({operation}) => (operation === "create" ? 0 : 20)});
        const user = await prisma.user.create({data: {username: "alice", password: "x", otpLastUsedStep: 1}});

        // A non-atomic check-then-write lets both requests through ...
        const naive = async () => {
            const current = await prisma.user.findFirst({where: {id: user.id}});
            if ((current!.otpLastUsedStep ?? 0) >= 2) return false;
            await prisma.user.update({where: {id: user.id}, data: {otpLastUsedStep: 2}});
            return true;
        };
        expect(await Promise.all([naive(), naive()])).toEqual([true, true]);

        // ... while a conditional updateMany is a single atomic statement.
        const atomic = async () => (await prisma.user.updateMany({where: {id: user.id, otpLastUsedStep: {lt: 3}}, data: {otpLastUsedStep: 3}})).count === 1;
        expect((await Promise.all([atomic(), atomic()])).sort()).toEqual([false, true]);
    });
});
