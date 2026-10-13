import {describe, expect, it} from "vitest";
import {hasAnyRole, Role} from "@shared/roles";

describe("hasAnyRole", () => {
    it("grants OWNER access regardless of required roles", () => {
        expect(hasAnyRole([Role.OWNER], [Role.ADMIN])).toBe(true);
        expect(hasAnyRole([Role.OWNER], ["editor"])).toBe(true);
    });

    it("grants ADMIN everything except OWNER", () => {
        expect(hasAnyRole([Role.ADMIN], ["editor"])).toBe(true);
        expect(hasAnyRole([Role.ADMIN], [Role.OWNER])).toBe(false);
    });

    it("treats no required roles as 'any authenticated user'", () => {
        expect(hasAnyRole([Role.ADMIN], [])).toBe(true);
        expect(hasAnyRole([], [])).toBe(true);
    });

    it("denies a role requirement when the user has no matching role", () => {
        expect(hasAnyRole([], [Role.ADMIN])).toBe(false);
        expect(hasAnyRole(["viewer"], ["editor"])).toBe(false);
    });
});
