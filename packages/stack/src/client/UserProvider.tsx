import {createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState} from "react";
import {SessionUserType, UserAuthState, UserStatusType} from "../shared/types/user";
import {apiFetch, clearCsrfToken} from "./helpers";

export type UserContextType = {
    user: SessionUserType | null;
    /**
     * Sets the signed-in user (e.g. after a successful login step). Also
     * drops the cached CSRF token, because the server issues a new session.
     */
    setUser: (user: SessionUserType | null) => void;
    /** True until the initial `/api/auth/me` request has finished. */
    loading: boolean;
    authStage: UserAuthState;
    /** Sets the auth stage (login, OTP, setup...). Also drops the cached CSRF token. */
    setAuthStage: (authStage: UserAuthState) => void;
    /** Ends the session on the server and resets the local state (also when the request fails). */
    logout: () => Promise<void>;
};

const UserContext = createContext<UserContextType | undefined>(undefined);

export function UserProvider({children}: {children: ReactNode}) {
    const [user, setUserState] = useState<SessionUserType | null>(null);
    const [loading, setLoading] = useState(true);
    const [authStage, setAuthStageState] = useState<UserAuthState>(UserAuthState.LOGIN);
    // The in-flight /me request; aborted on unmount and superseded by logout.
    const meRequest = useRef<AbortController | null>(null);

    useEffect(() => {
        const controller = new AbortController();
        meRequest.current = controller;

        apiFetch<UserStatusType>("/api/auth/me", {signal: controller.signal})
            .then(status => {
                if (controller.signal.aborted) return;
                setUserState(status?.user ?? null);
                setAuthStageState(status?.authState ?? UserAuthState.LOGIN);
            })
            .catch(() => {
                if (controller.signal.aborted) return;
                setUserState(null);
                setAuthStageState(UserAuthState.LOGIN);
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
                if (meRequest.current === controller) meRequest.current = null;
            });

        // Runs on unmount and on StrictMode's simulated unmount: the aborted
        // request never touches state; the re-run effect makes a fresh one.
        return () => controller.abort();
    }, []);

    const setUser = useCallback((next: SessionUserType | null) => {
        clearCsrfToken();
        setUserState(next);
    }, []);

    const setAuthStage = useCallback((next: UserAuthState) => {
        clearCsrfToken();
        setAuthStageState(next);
    }, []);

    const logout = useCallback(async () => {
        // A /me response arriving after logout must not sign the user back in.
        meRequest.current?.abort();
        setLoading(false);

        let nextStage = UserAuthState.LOGIN;
        try {
            const status = await apiFetch<UserStatusType>("/api/auth/logout", {method: "POST"});
            nextStage = status?.authState ?? UserAuthState.LOGIN;
        } catch {
            // The local session is cleared regardless.
        } finally {
            clearCsrfToken();
        }

        setUserState(null);
        setAuthStageState(nextStage);
    }, []);

    const value = useMemo<UserContextType>(
        () => ({user, setUser, loading, authStage, setAuthStage, logout}),
        [user, setUser, loading, authStage, setAuthStage, logout],
    );

    return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
}

export function useUser(): UserContextType {
    const ctx = useContext(UserContext);
    if (!ctx) throw new Error("useUser must be inside UserProvider");
    return ctx;
}

export {UserContext};
