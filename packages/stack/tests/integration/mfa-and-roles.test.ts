import {expect, it} from "vitest";
import type {Express} from "express";
import {advanceClock, agentFor, completeSetup, csrf, totp} from "../helpers";
import {createRealServer, describeDb, useDatabase} from "./support";

const OWNER_PASSWORD = "owner-password-123";

async function pendingMfa(app: Express) {
    const agent = agentFor(app);
    const token = await csrf(agent);
    const res = await agent.post("/api/auth/login").set("X-CSRF-Token", token).send({username: "owner", password: OWNER_PASSWORD});
    expect(res.body.data.authState).toBe("otp");
    return {agent, token: await csrf(agent)};
}

describeDb("TOTP replay protection across instances (M5)", () => {
    const db = useDatabase();

    it("a code is accepted once, even when two instances verify it concurrently", async () => {
        const a = await createRealServer(db.prisma());
        const b = await createRealServer(db.second());
        const {secret} = await completeSetup(agentFor(a.app), "owner", OWNER_PASSWORD);
        advanceClock(31_000); // past the step used by setup

        const [onA, onB] = await Promise.all([pendingMfa(a.app), pendingMfa(b.app)]);
        const code = totp(secret);
        const results = await Promise.all([onA, onB].map(({agent, token}) =>
            agent.post("/api/auth/login/verify").set("X-CSRF-Token", token).send({token: code})));

        expect(results.map(res => res.body.data.authState).sort()).toEqual(["authenticated", "otp"]);

        // Sequentially on the other instance, too.
        const later = await pendingMfa(b.app);
        const replay = await later.agent.post("/api/auth/login/verify").set("X-CSRF-Token", later.token).send({token: code});
        expect(replay.body.data.authState).toBe("otp");
    });
});

describeDb("roles across restarts (H5)", () => {
    const db = useDatabase();

    it("app roles and assignments survive a reboot with a different role config (add-only sync)", async () => {
        const first = await createRealServer(db.prisma(), {roles: ["editor"]});
        await first.server.dependencies.userService.createUser("ed", "editor-password-1", ["editor"]);

        // Reboot without the role configured, then with an extra one.
        await createRealServer(db.second(), {roles: []});
        await createRealServer(db.second(), {roles: ["viewer"]});

        const roles = (await db.prisma().role.findMany({select: {name: true}})).map(role => role.name).sort();
        expect(roles).toEqual(["admin", "editor", "owner", "viewer"]);
        const ed = await db.prisma().user.findFirst({where: {username: "ed"}, include: {roles: {include: {role: true}}}});
        expect(ed?.roles.map(userRole => userRole.role.name)).toEqual(["editor"]);
    });
});
