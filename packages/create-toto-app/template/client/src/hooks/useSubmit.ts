import {useCallback, useRef, useState} from "react";
import {errorMessage} from "@client/lib/apiErrors";

/**
 * Wraps an async form action with loading/error state and a re-entrancy
 * guard, so a second submit (Enter + click, or TOTP auto-submit + Enter)
 * is ignored while the first request is still in flight.
 */
export function useSubmit() {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inFlight = useRef(false);

    const run = useCallback(async (action: () => Promise<void>) => {
        if (inFlight.current) return;
        inFlight.current = true;
        setLoading(true);
        setError(null);
        try {
            await action();
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            inFlight.current = false;
            setLoading(false);
        }
    }, []);

    return {loading, error, setError, run};
}
