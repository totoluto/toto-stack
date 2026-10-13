import logo from "@client/assets/logo.svg";
import {FormEvent, useState} from "react";
import {apiFetch} from "toto-stack/client";
import {UserAuthState, UserStatusType} from "toto-stack/shared";
import {useSubmit} from "@client/hooks/useSubmit";
import {FormError} from "@client/components/auth/FormError";

export function LoginForm<T>({onSuccess}: {onSuccess: (userStatus: T) => void}) {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const {loading, error, setError, run} = useSubmit();

    function handleSubmit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        void run(async () => {
            const userStatus = await apiFetch<T>("/api/auth/login", {
                method: "POST",
                body: JSON.stringify({username, password}),
            });

            // The server replies 200 with authState "login" when credentials
            // are wrong - surface that instead of silently staying here.
            const status = userStatus as UserStatusType;
            if (!status.user && status.authState === UserAuthState.LOGIN) {
                setError("Invalid username or password.");
                return;
            }

            onSuccess(userStatus);
        });
    }

    return (
        <div className="login-container">
            <form className="login" onSubmit={handleSubmit} aria-labelledby="login-title">
                <div className="logo-container">
                    <img src={logo} alt="" />
                </div>
                <h2 id="login-title">Sign in</h2>
                <div className="form-field">
                    <label htmlFor="username">Username</label>
                    <input
                        id="username"
                        name="username"
                        type="text"
                        autoComplete="username"
                        autoFocus
                        required
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                    />
                </div>
                <div className="form-field">
                    <label htmlFor="password">Password</label>
                    <input
                        id="password"
                        name="password"
                        type="password"
                        autoComplete="current-password"
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                    />
                </div>
                <button type="submit" disabled={loading}>
                    {loading ? "Signing in..." : "Sign in"}
                </button>

                <FormError message={error} />
            </form>
        </div>
    );
}
