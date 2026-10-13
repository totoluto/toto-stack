import {expect, it} from "vitest";
import {agentFor, csrf, postJson, TEST_SETUP_TOKEN, totp} from "../helpers";
import {createRealServer, describeDb, useDatabase} from "./support";

const PASSWORD = "owner-password-123";

describeDb("first-run setup on MariaDB (C3)", () => {
    const db = useDatabase();

    it("requires the setup token", async () => {
        const {app} = await createRealServer(db.prisma());
        const agent = agentFor(app);

        const missing = await postJson(agent, "/api/auth/setup/start", {username: "owner", password: PASSWORD});
        expect(missing.status).toBe(400);
        const wrong = await postJson(agent, "/api/auth/setup/start", {username: "owner", password: PASSWORD, setupToken: "wrong-token"});
        expect(wrong.status).toBe(403);
        expect(wrong.body.code).toBe("SETUP_TOKEN_INVALID");

        expect(await db.prisma().user.count()).toBe(0);
    });

    it("concurrent setups on one instance create exactly one owner (transaction + SetupLock)", async () => {
        const {app} = await createRealServer(db.prisma());
        const contenders = await Promise.all(["alpha", "bravo", "charlie", "delta"].map(async username => {
            const agent = agentFor(app);
            const start = await postJson(agent, "/api/auth/setup/start", {username, password: PASSWORD, setupToken: TEST_SETUP_TOKEN});
            expect(start.status).toBe(200);
            return {agent, secret: start.body.data.key as string, token: await csrf(agent)};
        }));

        const results = await Promise.all(contenders.map(({agent, secret, token}) =>
            agent.post("/api/auth/setup/verify").set("X-CSRF-Token", token).send({token: totp(secret)})));

        const winners = results.filter(res => res.body.data?.user);
        expect(winners).toHaveLength(1);
        for (const loser of results.filter(res => !res.body.data?.user)) {
            expect(loser.status).toBe(403);
            expect(loser.body.code).toBe("SETUP_COMPLETED");
        }

        const users = await db.prisma().user.findMany({include: {roles: {include: {role: true}}}}) as {username: string; roles: {role: {name: string}}[]}[];
        expect(users).toHaveLength(1);
        expect(users[0].username).toBe(winners[0].body.data.user.username);
        expect(users[0].roles.map(userRole => userRole.role.name)).toEqual(["owner"]);
        expect(await db.prisma().setupLock.count()).toBe(1);
    });

    it("concurrent setups on two instances sharing the database create exactly one owner", async () => {
        const a = await createRealServer(db.prisma());
        const b = await createRealServer(db.second());
        const contenders = await Promise.all([[a.app, "alpha"], [b.app, "bravo"], [a.app, "charlie"], [b.app, "delta"]].map(async ([app, username]) => {
            const agent = agentFor(app as typeof a.app);
            const start = await postJson(agent, "/api/auth/setup/start", {username, password: PASSWORD, setupToken: TEST_SETUP_TOKEN});
            expect(start.status).toBe(200);
            return {agent, secret: start.body.data.key as string, token: await csrf(agent)};
        }));

        const results = await Promise.all(contenders.map(({agent, secret, token}) =>
            agent.post("/api/auth/setup/verify").set("X-CSRF-Token", token).send({token: totp(secret)})));

        expect(results.filter(res => res.body.data?.user)).toHaveLength(1);
        expect(await db.prisma().user.count()).toBe(1);
        expect(await db.prisma().setupLock.count()).toBe(1);

        // Both instances now refuse setup, whichever one won (state is re-checked in the DB).
        for (const app of [a.app, b.app]) {
            const again = await postJson(agentFor(app), "/api/auth/setup/start", {username: "late", password: PASSWORD, setupToken: TEST_SETUP_TOKEN});
            expect(again.status).toBe(403);
        }
    });
});
