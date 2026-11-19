import {useCallback, useEffect, useRef, useState} from "react";
import {apiFetch} from "toto-stack/client";
import {errorMessage} from "@client/lib/apiErrors";

type AccountSnapshot = {
    account: {id: number; username: string; roles: string[]; otpEnabled: boolean; apiKeyEnabled: boolean};
    sessions: {id: string; current: boolean; ipAddress: string | null; userAgent: string | null; createdAt: string; lastSeenAt: string; expiresAt: string}[];
};

export function useAccount() {
    const [snapshot, setSnapshot] = useState<AccountSnapshot | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inFlight = useRef<Promise<void> | null>(null);
    const queued = useRef(false);
    const refresh = useCallback(() => {
        queued.current = true;
        if (inFlight.current) return inFlight.current;
        setLoading(true);
        inFlight.current = (async () => {
            try {
                // Overlapping callers share the promise through every trailing read.
                do {
                    queued.current = false;
                    setError(null);
                    try {
                        setSnapshot(await apiFetch<AccountSnapshot>("/api/account"));
                    } catch (error) {
                        setSnapshot(null);
                        setError(errorMessage(error));
                    }
                } while (queued.current);
            } finally {
                inFlight.current = null;
                setLoading(false);
            }
        })();
        return inFlight.current;
    }, []);
    useEffect(() => {void refresh();}, [refresh]);
    return {snapshot, loading, error, refresh};
}
