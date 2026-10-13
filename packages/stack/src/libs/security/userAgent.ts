/** Length of the Session.userAgent column (`@db.VarChar(512)` in base.prisma). */
export const USER_AGENT_MAX_LENGTH = 512;

/**
 * A User-Agent header cut to what Session.userAgent can store. Under MySQL
 * strict mode a longer value would make the session write fail.
 */
export function truncateUserAgent(userAgent: string | undefined): string | undefined {
    return userAgent === undefined ? undefined : userAgent.slice(0, USER_AGENT_MAX_LENGTH);
}
