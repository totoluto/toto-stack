/**
 * Built-in roles. Apps add their own role names via `createServer({roles})`;
 * a role is just a string. Define app roles alongside the built-ins:
 *
 *     export const AppRole = {...Role, EDITOR: "editor"} as const;
 */
export const Role = {
    /** Superuser: satisfies every role requirement. Created by the first-run setup. */
    OWNER: "owner",
    /** Satisfies every role requirement except `owner`. */
    ADMIN: "admin",
} as const;

/** One of the built-in role names. */
export type BuiltinRole = (typeof Role)[keyof typeof Role];

/**
 * A role name: a built-in role or any app-defined role string.
 * (`string & {}` keeps editor autocompletion for the built-ins.)
 */
export type Role = BuiltinRole | (string & {});

/** The built-in role names, in privilege order. */
export const BUILTIN_ROLES: readonly BuiltinRole[] = [Role.OWNER, Role.ADMIN];

/**
 * Whether a user holding `userRoles` satisfies at least one of `requiredRoles`.
 *
 * - An empty (or omitted) `requiredRoles` means "any authenticated user", so it
 *   always returns true. Callers are responsible for checking authentication.
 * - `owner` satisfies every requirement.
 * - `admin` satisfies every requirement except `owner`.
 */
export function hasAnyRole(
    userRoles: readonly Role[] | null | undefined,
    requiredRoles: readonly Role[] = [],
): boolean {
    if (requiredRoles.length === 0) return true;
    if (!userRoles || userRoles.length === 0) return false;
    if (userRoles.includes(Role.OWNER)) return true;

    const isAdmin = userRoles.includes(Role.ADMIN);
    return requiredRoles.some(role => userRoles.includes(role) || (isAdmin && role !== Role.OWNER));
}

/**
 * Whether a user holding `granterRoles` may assign `role` to another user.
 * Only an owner may grant `owner` or `admin`; an admin may grant any other
 * role; nobody else may grant roles.
 */
export function canGrantRole(granterRoles: readonly Role[] | null | undefined, role: Role): boolean {
    if (!granterRoles) return false;
    if (granterRoles.includes(Role.OWNER)) return true;
    if (granterRoles.includes(Role.ADMIN)) return !(BUILTIN_ROLES as readonly Role[]).includes(role);
    return false;
}
