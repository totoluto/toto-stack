import {describe, expect, it} from "vitest";
import express from "express";
import request from "supertest";
import type {Request} from "express";
import {getRequestIP, rateLimitClientKey} from "@server/libs/security/clientIp";

const fakeReq = (ip: string | undefined, remoteAddress?: string) => ({ip, socket: {remoteAddress}}) as unknown as Request;

describe("getRequestIP", () => {
    it("returns validated addresses from req.ip, then the socket peer", () => {
        expect(getRequestIP(fakeReq("203.0.113.7"))).toBe("203.0.113.7");
        expect(getRequestIP(fakeReq("2001:db8::1"))).toBe("2001:db8::1");
        expect(getRequestIP(fakeReq("::ffff:198.51.100.4"))).toBe("198.51.100.4");
        expect(getRequestIP(fakeReq("fe80::1%eth0"))).toBe("fe80::1");
        expect(getRequestIP(fakeReq("not-an-ip, 1.2.3.4", "192.0.2.9"))).toBe("192.0.2.9");
        expect(getRequestIP(fakeReq("__proto__", "garbage"))).toBeUndefined();
        expect(getRequestIP(fakeReq(undefined, undefined))).toBeUndefined();
    });

    it("only honours X-Forwarded-For through the trust proxy setting", async () => {
        const app = (trustProxy: boolean | number) => express()
            .set("trust proxy", trustProxy)
            .get("/", (req, res) => res.json({ip: getRequestIP(req) ?? null}));

        const spoofed = await request(app(false)).get("/").set("X-Forwarded-For", "203.0.113.7");
        expect(spoofed.body.ip).not.toBe("203.0.113.7");
        expect(spoofed.body.ip).toMatch(/^(127\.0\.0\.1|::1)$/);

        const proxied = await request(app(1)).get("/").set("X-Forwarded-For", "203.0.113.7");
        expect(proxied.body.ip).toBe("203.0.113.7");

        const garbage = await request(app(1)).get("/").set("X-Forwarded-For", "<script>");
        expect(garbage.body.ip).toMatch(/^(127\.0\.0\.1|::1)$/);
    });
});

describe("rateLimitClientKey", () => {
    it("builds on getRequestIP and groups IPv6 by /64", () => {
        expect(rateLimitClientKey(fakeReq("::ffff:198.51.100.4"))).toBe("198.51.100.4");
        expect(rateLimitClientKey(fakeReq("2001:db8:1:2:3:4:5:6"))).toBe("2001:db8:1:2::/64");
        expect(rateLimitClientKey(fakeReq("garbage", undefined))).toBe("unknown");
    });
});
