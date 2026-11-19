import {createHash} from "node:crypto";

/** Public session handle; the raw ID remains a session credential. */
export function opaqueSessionId(sessionId: string): string {
    return createHash("sha256").update(sessionId).digest("base64url");
}
