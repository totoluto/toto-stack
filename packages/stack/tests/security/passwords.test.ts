import {describe, expect, it} from "vitest";
import request from "supertest";
import * as argon2 from "@node-rs/argon2";
import {PasswordHasher} from "@server/libs/security/PasswordHasher";
import {AppError} from "@server/libs/ErrorHandler";
import type {RateLimitStore} from "@server/libs/security/RateLimitStore";
import {agentFor, csrf, postJson} from "../helpers";
import {createUserVia, fakePrisma, serverWithOwner} from "./support";

describe("password hashing (H9, L19)", () => {
    const hasher = new PasswordHasher();

    it("hashes with Argon2id (OWASP parameters, PHC string) and verifies", async () => {
        const hash = await hasher.hash("correct horse battery staple");

        expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
        expect(await hasher.hash("correct horse battery staple")).not.toBe(hash);
        expect(await hasher.verify("correct horse battery staple", hash)).toEqual({valid: true, needsRehash: false});
        expect(await hasher.verify("correct horse battery stapl", hash)).toEqual({valid: false, needsRehash: false});
        expect(await hasher.verify("", hash)).toEqual({valid: false, needsRehash: false});
    });

    it("has no 72-byte limit and normalises Unicode", async () => {
        const long = "x".repeat(72);
        const hash = await hasher.hash(`${long}A`);
        expect((await hasher.verify(`${long}B`, hash)).valid).toBe(false);

        const composed = await hasher.hash("caf\u00e9-password");
        expect((await hasher.verify("cafe\u0301-password", composed)).valid).toBe(true);
    });

    it("asks to rehash Argon2id hashes with other parameters", async () => {
        const old = await argon2.hash("pw-1234567890", {memoryCost: 8192, timeCost: 3, parallelism: 1});
        expect(old).toMatch(/^\$argon2id\$v=19\$m=8192,t=3,p=1\$/);
        expect(await hasher.verify("pw-1234567890", old)).toEqual({valid: true, needsRehash: true});
        expect(await hasher.verify("wrong-password", old)).toEqual({valid: false, needsRehash: false});

        const stronger = new PasswordHasher({memoryCost: 32768, timeCost: 3});
        expect(await stronger.hash("pw")).toMatch(/^\$argon2id\$v=19\$m=32768,t=3,p=1\$/);
    });

    it("treats tampered, foreign and unsupported hashes as invalid without throwing", async () => {
        const good = await hasher.hash("pw-1234567890");
        const [, , , params, salt, digest] = good.split("$");
        const flip = (text: string) => text.slice(0, -2) + (text.at(-2) === "A" ? "B" : "A") + text.at(-1);

        for (const encoded of [
            `$argon2id$v=19$${params}$${salt}$${flip(digest)}`, // tampered digest
            `$argon2id$v=19$${params}$${flip(salt)}$${digest}`, // tampered salt
            `$argon2id$v=19$m=19456,t=3,p=1$${salt}$${digest}`, // tampered parameters
            `$argon2id$v=19$m=4194304,t=2,p=1$${salt}$${digest}`, // 4 GiB: over the cap, no work
            `$argon2id$v=19$m=19456,t=99,p=1$${salt}$${digest}`,
            `$argon2i$v=19$${params}$${salt}$${digest}`, // not Argon2id
            "$argon2id$garbage",
            "plaintext-password",
            "",
        ]) {
            expect(await hasher.verify("pw-1234567890", encoded), encoded).toEqual({valid: false, needsRehash: false});
        }
    });

    it("accepts only Argon2id: other formats (bcrypt, scrypt, PBKDF2) are invalid and cost no work", async () => {
        const started = performance.now();
        await hasher.hash("baseline-password");
        const oneHashMs = performance.now() - started;

        const others = [
            "$2b$12$C6UzMDM.H6dfI/f/IKxGhuYyHhbJUBxCk3UJeY6l7vqVIQYKpXiVa", // bcrypt format: not accepted
            "$scrypt$ln=16,r=8,p=2$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g",
            "$pbkdf2-sha256$29000$N2bsvRfi3Lv3vhcCYMx5bw$cPyRrHoE5fqY2pS.zZ4QXJCqa7Vrw9WoGFS1bJQqTXA",
        ];
        const verifyStarted = performance.now();
        const results = await Promise.all(others.flatMap(encoded => Array.from({length: 20}, () => hasher.verify("some-password-1", encoded))));
        expect(results.every(result => !result.valid && !result.needsRehash)).toBe(true);
        // 60 checks together cost far less than one real hash
        expect(performance.now() - verifyStarted).toBeLessThan(oneHashMs);
    });

    it("does not block the event loop while hashing or verifying", async () => {
        // A blocking implementation stalls the loop for the whole batch; best of 3 against CI noise.
        const stored = await hasher.hash("some-password-1");
        const sample = async (work: () => Promise<unknown>) => {
            let maxGap = 0;
            let last = performance.now();
            const timer = setInterval(() => {
                const now = performance.now();
                maxGap = Math.max(maxGap, now - last);
                last = now;
            }, 1);
            const started = performance.now();
            try {
                await work();
            } finally {
                clearInterval(timer);
            }
            return maxGap / (performance.now() - started);
        };

        for (const work of [
            () => Promise.all(Array.from({length: 8}, (_, i) => hasher.hash(`password-${i}`))),
            () => Promise.all(Array.from({length: 8}, () => hasher.verify("some-password-1", stored))),
        ]) {
            const ratios = [await sample(work), await sample(work), await sample(work)];
            expect(Math.min(...ratios)).toBeLessThan(0.5);
        }
    });

    it("sheds load: at most `concurrency` running and `queueLimit` waiting, then 503 OVERLOADED", async () => {
        const small = new PasswordHasher({concurrency: 1, queueLimit: 2});
        const results = await Promise.allSettled(Array.from({length: 6}, (_, i) => small.hash(`pw-${i}`)));

        expect(results.filter(result => result.status === "fulfilled")).toHaveLength(3);
        const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        expect(rejected).toHaveLength(3);
        expect(rejected[0].reason).toBeInstanceOf(AppError);
        expect(rejected[0].reason).toMatchObject({status: 503, code: "OVERLOADED", headers: {"Retry-After": "1"}, expose: true});

        // Verification shares the same slots
        const stored = await small.hash("pw-stored");
        const mixed = await Promise.allSettled([small.hash("a"), small.verify("pw-stored", stored), small.hash("b"), small.verify("x", stored)]);
        expect(mixed.filter(result => result.status === "rejected")).toHaveLength(1);

        // Capacity frees up again
        expect(await small.hash("after")).toMatch(/^\$argon2id\$/);
    });

    it("rehashes on login when the configured Argon2 parameters changed, then keeps working", async () => {
        const {app, owner} = await serverWithOwner();
        await createUserVia(owner, "carol", "placeholder-pass-1");
        const user = (await fakePrisma.user.findFirst({where: {username: "carol"}}))!;
        // Hashed with weaker parameters than the configured ones (e.g. before an operator raised them)
        await fakePrisma.user.update({where: {id: user.id}, data: {password: await argon2.hash("carol-password-12", {memoryCost: 8192, timeCost: 2, parallelism: 1})}});

        const wrong = await postJson(agentFor(app), "/api/auth/login", {username: "carol", password: "wrong-password-12"});
        expect(wrong.body.data.authState).toBe("login");
        expect((await fakePrisma.user.findFirst({where: {id: user.id}}))!.password).toMatch(/^\$argon2id\$v=19\$m=8192,/);

        const login = await postJson(agentFor(app), "/api/auth/login", {username: "carol", password: "carol-password-12"});
        expect(login.body.data.authState).toBe("authenticated");
        expect((await fakePrisma.user.findFirst({where: {id: user.id}}))!.password).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);

        const again = await postJson(agentFor(app), "/api/auth/login", {username: "carol", password: "carol-password-12"});
        expect(again.body.data.authState).toBe("authenticated");
    });

    it("a user whose stored hash isn't Argon2id can't log in, and nothing crashes", async () => {
        const {app, owner} = await serverWithOwner();
        await createUserVia(owner, "dave", "placeholder-pass-1");
        const user = (await fakePrisma.user.findFirst({where: {username: "dave"}}))!;
        await fakePrisma.user.update({where: {id: user.id}, data: {password: "$2b$12$C6UzMDM.H6dfI/f/IKxGhuYyHhbJUBxCk3UJeY6l7vqVIQYKpXiVa"}});

        const res = await postJson(agentFor(app), "/api/auth/login", {username: "dave", password: "anything-at-all"});
        expect(res.status).toBe(200);
        expect(res.body.data.authState).toBe("login");
    });
});

describe("overload responses (F2)", () => {
    const unlimited: RateLimitStore = {
        increment: () => ({count: 0, resetAt: Date.now() + 60_000}),
        decrement: () => undefined,
        reset: () => undefined,
    };

    it("answers a login burst beyond the hash queue with 503 OVERLOADED and Retry-After", async () => {
        const {app} = await serverWithOwner({security: {rateLimitStore: unlimited, passwordHashing: {concurrency: 1, queueLimit: 1, memoryCost: 65536}}});
        const listener = app.listen(0, "127.0.0.1");
        await new Promise(resolve => listener.once("listening", resolve));

        try {
            // Tokens first, then all logins at once, so they really overlap
            const agents = await Promise.all(Array.from({length: 12}, async () => {
                const agent = request.agent(listener);
                return {agent, token: await csrf(agent)};
            }));
            const attempts = await Promise.all(agents.map(({agent, token}, i) =>
                agent.post("/api/auth/login").set("X-CSRF-Token", token).send({username: `nobody-${i}`, password: "wrong-password"})));

            const overloaded = attempts.filter(res => res.status === 503);
            expect(overloaded.length).toBeGreaterThan(0);
            expect(attempts.filter(res => res.status === 200).length).toBeGreaterThanOrEqual(2);
            expect(overloaded[0].body).toEqual({status: "error", message: "The server is busy. Try again in a moment.", code: "OVERLOADED"});
            expect(overloaded[0].headers["retry-after"]).toBe("1");
        } finally {
            listener.close();
        }
    });

    it("keeps the code and message of an exposed 5xx AppError in production", async () => {
        const express = (await import("express")).default;
        const {createErrorHandler} = await import("@server/libs/ErrorHandler");
        const app = express()
            .get("/busy", () => {
                throw new AppError(503, "busy", {code: "OVERLOADED", headers: {"Retry-After": "1"}, expose: true});
            })
            .get("/broken", () => {
                throw new AppError(500, "internal detail", {code: "SECRET_DETAIL"});
            })
            .use(createErrorHandler({isDev: false}));

        const busy = await request(app).get("/busy");
        expect(busy.status).toBe(503);
        expect(busy.body).toEqual({status: "error", message: "busy", code: "OVERLOADED"});
        expect(busy.headers["retry-after"]).toBe("1");

        const broken = await request(app).get("/broken");
        expect(broken.body).toEqual({status: "error", message: "Internal Server Error", code: "INTERNAL_ERROR"});
    });
});

describe("login timing (M2)", () => {
    // Never limits, so repeated attempts all reach the password check
    const unlimited: RateLimitStore = {
        increment: () => ({count: 0, resetAt: Date.now() + 60_000}),
        decrement: () => undefined,
        reset: () => undefined,
    };

    it("takes about as long for unknown usernames as for known ones", async () => {
        const {app, owner} = await serverWithOwner({security: {rateLimitStore: unlimited}});
        await createUserVia(owner, "known", "known-password-1");

        const time = async (username: string) => {
            const agent = agentFor(app);
            const token = await csrf(agent);
            const started = performance.now();
            const res = await agent.post("/api/auth/login").set("X-CSRF-Token", token).send({username, password: "wrong-password"});
            const elapsed = performance.now() - started;
            expect(res.body).toEqual({status: "success", message: "Login processed", data: {user: null, authState: "login"}});
            return elapsed;
        };

        await time("known"); // warm-up
        const known: number[] = [];
        const unknown: number[] = [];
        for (let i = 0; i < 7; i++) {
            known.push(await time("known"));
            unknown.push(await time(`nobody-${i}`));
        }

        const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
        const ratio = median(known) / median(unknown);
        // Before the fix: ~222 ms vs ~0.7 ms (ratio ~300). Generous bounds against CI noise.
        expect(ratio).toBeGreaterThan(0.5);
        expect(ratio).toBeLessThan(2);
    });
});
