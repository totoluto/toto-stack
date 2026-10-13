import net from "node:net";
import type {Request} from "express";

/**
 * The client's IP address, or undefined when none is valid.
 *
 * Uses `req.ip`, which honours `http.trustProxy` (Express only reads
 * X-Forwarded-For from trusted proxies; never parse that header yourself),
 * then the socket peer. Values are validated with net.isIP (a trusted proxy
 * can still forward garbage); IPv6 zone ids are dropped and IPv4-mapped IPv6
 * addresses are unwrapped.
 */
export function getRequestIP(req: Request): string | undefined {
    for (const candidate of [req.ip, req.socket?.remoteAddress]) {
        const address = candidate?.split("%")[0];
        if (!address || !net.isIP(address)) continue;

        const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
        return mapped && net.isIPv4(mapped[1]) ? mapped[1] : address;
    }

    return undefined;
}

/**
 * The client key used for rate limiting: getRequestIP(), or "unknown".
 * IPv6 addresses are reduced to a prefix: /64 by default (one client
 * usually controls a whole /64), or /56 for unauthenticated endpoints where
 * an attacker would rotate through the 256 /64s of a typical /56 delegation.
 */
export function rateLimitClientKey(req: Request, ipv6Prefix: 56 | 64 = 64): string {
    const address = getRequestIP(req);
    return address ? normalizeAddress(address, ipv6Prefix) : "unknown";
}

function normalizeAddress(address: string, ipv6Prefix: 56 | 64): string {
    if (net.isIPv4(address)) {
        return address;
    }

    const groups = expandIPv6(address.toLowerCase());
    if (!groups) {
        return address.toLowerCase();
    }

    // ::ffff:a.b.c.d (IPv4-mapped) is the IPv4 client itself
    if (groups.slice(0, 5).every(group => group === "0") && groups[5] === "ffff") {
        const high = parseInt(groups[6], 16);
        const low = parseInt(groups[7], 16);
        return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
    }

    if (ipv6Prefix === 56) {
        // The 4th hextet keeps only its high byte
        return `${groups.slice(0, 3).join(":")}:${(parseInt(groups[3], 16) & 0xff00).toString(16)}::/56`;
    }

    return `${groups.slice(0, 4).join(":")}::/64`;
}

/** The 8 hextets of an IPv6 address (handles "::" and a trailing dotted IPv4 part). */
function expandIPv6(address: string): string[] | null {
    let text = address;
    const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
    if (dotted) {
        const octets = dotted[1].split(".").map(Number);
        const tail = `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
        text = text.slice(0, -dotted[1].length) + tail;
    }

    const [head, rest] = text.split("::");
    const headGroups = head ? head.split(":") : [];
    const restGroups = rest ? rest.split(":") : [];
    const missing = 8 - headGroups.length - restGroups.length;
    if (missing < 0 || (rest === undefined && missing !== 0)) {
        return null;
    }

    return [...headGroups, ...Array<string>(missing).fill("0"), ...restGroups]
        .map(group => (parseInt(group, 16) || 0).toString(16));
}
