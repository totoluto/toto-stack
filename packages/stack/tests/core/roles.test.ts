import {beforeEach, describe, expect, it} from "vitest";
import request from "supertest";
import {BaseRoute, canGrantRole, Dependencies, hasAnyRole, Role} from "toto-stack";
import fakePrisma, {resetFakeDb} from "../fakePrisma";
import {makeServer} from "./support";

class EditorRoute extends BaseRoute {
    constructor(dependencies: Dependencies) {
        super("/editor", dependencies, {roles: ["editor"]});
    }

    protected registerRoutes(): void {
        this.get("/", (_req, res) => res.json({ok: "editor"}));
        this.get("/any", (_req, res) => res.json({ok: "any"}), {roles: []});
        this.get("/owner", (_req, res) => res.json({ok: "owner"}), {roles: [Role.OWNER]});
        this.get("/public", (_req, res) => res.json({ok: "public"}), {auth: false});
    }
}

describe("role semantics (H1/L20)", () => {
    it("owner satisfies everything, admin everything but owner", () => {
        expect(hasAnyRole([Role.OWNER], [Role.OWNER])).toBe(true);
        expect(hasAnyRole([Role.ADMIN], [Role.OWNER])).toBe(false);
        expect(hasAnyRole([Role.ADMIN], [Role.OWNER, "editor"])).toBe(true);
        expect(hasAnyRole(["editor"], [Role.ADMIN])).toBe(false);
    });

    it("an empty requirement means any authenticated user", () => {
        expect(hasAnyRole([], [])).toBe(true);
        expect(hasAnyRole(undefined)).toBe(true);
    });

    it("only an owner may grant owner/admin; admins may grant app roles", () => {
        expect(canGrantRole([Role.OWNER], Role.OWNER)).toBe(true);
        expect(canGrantRole([Role.OWNER], Role.ADMIN)).toBe(true);
        expect(canGrantRole([Role.ADMIN], Role.OWNER)).toBe(false);
        expect(canGrantRole([Role.ADMIN], Role.ADMIN)).toBe(false);
        expect(canGrantRole([Role.ADMIN], "editor")).toBe(true);
        expect(canGrantRole(["editor"], "editor")).toBe(false);
        expect(canGrantRole(null, "editor")).toBe(false);
    });
});

describe("role sync at boot (H5)", () => {
    beforeEach(() => resetFakeDb());

    it("never deletes roles or role assignments that exist in the database", async () => {
        await fakePrisma.role.createMany({data: [{name: "owner"}, {name: "admin"}, {name: "legacy"}]});
        const user = await fakePrisma.user.create({
            data: {username: "ed", password: "x", apiKey: "k", roles: {create: [{role: {connect: {name: "legacy"}}}]}},
        });

        await makeServer({roles: ["editor"]}).createApp();

        const roleNames = (await fakePrisma.role.findMany()).map(role => role.name);
        expect(roleNames.sort()).toEqual(["admin", "editor", "legacy", "owner"]);
        const after = await fakePrisma.user.findFirst({where: {id: user.id}, include: {roles: {include: {role: true}}}});
        expect(after?.roles.map(userRole => userRole.role.name)).toEqual(["legacy"]);
    });

    it("creates missing built-in and app roles, idempotently", async () => {
        await makeServer({roles: ["editor"]}).createApp();
        await makeServer({roles: ["editor", "viewer"]}).createApp();

        const roleNames = (await fakePrisma.role.findMany()).map(role => role.name);
        expect(roleNames.sort()).toEqual(["admin", "editor", "owner", "viewer"]);
    });
});

describe("role checks on routes", () => {
    let keys: Record<string, string>;
    let app: Awaited<ReturnType<ReturnType<typeof makeServer>["createApp"]>>;

    beforeEach(async () => {
        resetFakeDb();
        const server = makeServer({roles: ["editor"], routes: [EditorRoute]});
        app = await server.createApp();
        const {userService} = server.dependencies;
        keys = {};
        for (const [name, roles] of [["owner", [Role.OWNER]], ["admin", [Role.ADMIN]], ["editor", ["editor"]], ["member", []]] as const) {
            const user = await userService.createUser(name, "a-long-password", [...roles]);
            keys[name] = await userService.issueApiKey(user.id);
        }
    });

    const get = (path: string, who?: string) => {
        const req = request(app).get(path);
        return who ? req.set("Authorization", `Bearer ${keys[who]}`) : req;
    };

    it("enforces the route-level role requirement", async () => {
        expect((await get("/api/editor", "editor")).status).toBe(200);
        expect((await get("/api/editor", "admin")).status).toBe(200);
        expect((await get("/api/editor", "owner")).status).toBe(200);
        expect((await get("/api/editor", "member")).status).toBe(403);
        expect((await get("/api/editor")).status).toBe(401);
    });

    it("lets endpoints override the route options", async () => {
        expect((await get("/api/editor/any", "member")).status).toBe(200);
        expect((await get("/api/editor/any")).status).toBe(401);
        expect((await get("/api/editor/owner", "admin")).status).toBe(403);
        expect((await get("/api/editor/owner", "owner")).status).toBe(200);
        expect((await get("/api/editor/public")).status).toBe(200);
    });

    it("returns the standard error envelope for 401/403", async () => {
        const res = await get("/api/editor", "member");
        expect(res.body).toEqual({status: "error", message: "Missing permissions", code: "FORBIDDEN"});
        const anonymous = await get("/api/editor");
        expect(anonymous.body).toEqual({status: "error", message: "Unauthorized access.", code: "UNAUTHORIZED"});
    });
});
