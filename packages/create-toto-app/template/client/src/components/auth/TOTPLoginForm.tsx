import {FormEvent, useState} from "react";
import {apiFetch, ErrorCode, useUser} from "toto-stack/client";
import {errorCode} from "@client/lib/apiErrors";
import {TOTP} from "@client/components/auth/TOTP";
import {UserAuthState, UserStatusType} from "toto-stack/shared";
import {useSubmit} from "@client/hooks/useSubmit";
import {FormError} from "@client/components/auth/FormError";

const CODE_LENGTH = 6;

type TOTPLoginFormProps<T> = {
    onSuccess: (userStatus: T) => void;
};

export function TOTPLoginForm<T>({onSuccess}: TOTPLoginFormProps<T>) {
    const [otp, setOtp] = useState("");
    const {setAuthStage} = useUser();
    const {loading, error, setError, run} = useSubmit();

    function verify(code: string) {
        if (code.length !== CODE_LENGTH) return;

        void run(async () => {
            try {
                const userStatus = await apiFetch<T>("/api/auth/login/verify", {
                    method: "POST",
                    body: JSON.stringify({token: code}),
                });

                const status = userStatus as UserStatusType;
                if (!status.user) {
                    // "otp" = wrong/reused code, "login" = pending MFA session expired
                    setOtp("");
                    if (status.authState === UserAuthState.OTP) {
                        setError("Invalid code. Please try again.");
                    } else {
                        setError("Your sign-in expired. Please sign in again.");
                        onSuccess(userStatus);
                    }
                    return;
                }

                onSuccess(userStatus);
            } catch (e) {
                setOtp("");
                // The pending sign-in expired: back to the password step.
                if (errorCode(e) === ErrorCode.MFA_NOT_PENDING) setAuthStage(UserAuthState.LOGIN);
                throw e;
            }
        });
    }

    function handleSubmit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        verify(otp);
    }

    return (
        <div className="login-container">
            <form className="login" onSubmit={handleSubmit} aria-labelledby="totp-title">
                <h2 id="totp-title">Enter your authentication code</h2>

                <TOTP
                    length={CODE_LENGTH}
                    value={otp}
                    onChange={setOtp}
                    onComplete={verify}
                    disabled={loading}
                />

                <button type="submit" disabled={loading || otp.length !== CODE_LENGTH}>
                    {loading ? "Verifying..." : "Verify"}
                </button>

                <FormError message={error} />
            </form>
        </div>
    );
}
