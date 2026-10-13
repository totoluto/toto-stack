import logo from "@client/assets/logo.svg";
import {FormEvent, useState} from "react";
import {apiFetch, ErrorCode, useUser} from "toto-stack/client";
import {UserAuthState} from "toto-stack/shared";
import {errorCode} from "@client/lib/apiErrors";
import {useSubmit} from "@client/hooks/useSubmit";
import {FormError} from "@client/components/auth/FormError";

export function SetupForm<T>({onSuccess}: {onSuccess: (userStatus: T) => void}) {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [repeatedPassword, setRepeatedPassword] = useState("");
    const [setupToken, setSetupToken] = useState("");
    const {setAuthStage} = useUser();
    const {loading, error, setError, run} = useSubmit();

    function handleSubmit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (password !== repeatedPassword) {
            setError("The passwords do not match.");
            return;
        }

        void run(async () => {
            try {
                const userStatus = await apiFetch<T>("/api/auth/setup/start", {
                    method: "POST",
                    body: JSON.stringify({username, password, setupToken: setupToken.trim()}),
                });
                onSuccess(userStatus);
            } catch (e) {
                // Someone else finished the setup meanwhile: go to sign-in.
                if (errorCode(e) === ErrorCode.SETUP_COMPLETED) setAuthStage(UserAuthState.LOGIN);
                throw e;
            }
        });
    }

    return (
        <div className="login-container">
            <form className="login" onSubmit={handleSubmit} aria-labelledby="setup-title">
                <div className="logo-container">
                    <img src={logo} alt="" />
                </div>
                <h2 id="setup-title">Create the owner account</h2>
                <div className="form-field">
                    <label htmlFor="setupToken">Setup token</label>
                    <input
                        id="setupToken"
                        name="setupToken"
                        type="password"
                        autoComplete="off"
                        autoFocus
                        required
                        aria-describedby="setupToken-help"
                        value={setupToken}
                        onChange={(e) => setSetupToken(e.target.value)}
                    />
                    <p id="setupToken-help" className="field-help">
                        SETUP_TOKEN from the server's .env, or the one-time token the server printed at startup.
                    </p>
                </div>
                <div className="form-field">
                    <label htmlFor="username">Username</label>
                    <input
                        id="username"
                        name="username"
                        type="text"
                        autoComplete="username"
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
                        autoComplete="new-password"
                        required
                        minLength={10}
                        maxLength={256}
                        aria-describedby="password-help"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                    />
                    <p id="password-help" className="field-help">At least 10 characters.</p>
                </div>
                <div className="form-field">
                    <label htmlFor="repeatedPassword">Repeat password</label>
                    <input
                        id="repeatedPassword"
                        name="repeatedPassword"
                        type="password"
                        autoComplete="new-password"
                        required
                        value={repeatedPassword}
                        onChange={(e) => setRepeatedPassword(e.target.value)}
                    />
                </div>
                <button type="submit" disabled={loading}>
                    {loading ? "Creating..." : "Continue"}
                </button>

                <FormError message={error} />
            </form>
        </div>
    );
}
