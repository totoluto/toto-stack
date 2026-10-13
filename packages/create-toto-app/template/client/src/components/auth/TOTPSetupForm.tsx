import {FormEvent, useState} from "react";
import {apiFetch, ErrorCode, useUser} from "toto-stack/client";
import {errorCode} from "@client/lib/apiErrors";
import {CopyField} from "@client/components/CopyField";
import {TOTP} from "@client/components/auth/TOTP";
import {useSubmit} from "@client/hooks/useSubmit";
import {FormError} from "@client/components/auth/FormError";
import {UserAuthState, UserStatusType} from "toto-stack/shared";

const CODE_LENGTH = 6;

type TOTPSetupFormProps<T> = {
    qrCode: string;
    manualKey: string;
    onSuccess: (userStatus: T) => void;
};

export function TOTPSetupForm<T>({qrCode, manualKey, onSuccess}: TOTPSetupFormProps<T>) {
    const [otp, setOtp] = useState("");
    const {setAuthStage} = useUser();
    const {loading, error, setError, run} = useSubmit();

    function verify(code: string) {
        if (code.length !== CODE_LENGTH) return;

        void run(async () => {
            let userStatus: T;
            try {
                userStatus = await apiFetch<T>("/api/auth/setup/verify", {
                    method: "POST",
                    body: JSON.stringify({token: code}),
                });
            } catch (e) {
                setOtp("");
                const reason = errorCode(e);
                // The pending setup is gone (expired, restart, token changed) or someone else finished it.
                if (reason === ErrorCode.SETUP_NOT_STARTED || reason === ErrorCode.SETUP_TOKEN_CHANGED) {
                    setAuthStage(UserAuthState.SETUP);
                } else if (reason === ErrorCode.SETUP_COMPLETED) {
                    setAuthStage(UserAuthState.LOGIN);
                }
                throw e;
            }

            // A wrong code keeps the setup pending: stay here (keep the QR code).
            const status = userStatus as UserStatusType;
            if (!status.user && status.authState === UserAuthState.SETUP_VERIFY) {
                setOtp("");
                setError("Invalid code. Please try again.");
                return;
            }

            onSuccess(userStatus);
        });
    }

    function handleSubmit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        verify(otp);
    }

    return (
        <div className="login-container">
            <form className="login" onSubmit={handleSubmit} aria-labelledby="totp-setup-title">
                <h2 id="totp-setup-title">Set up two-factor authentication</h2>
                <p>Scan the QR code with an authenticator app, or enter the key manually, then type the 6-digit code.</p>
                <div className="center-items">
                    <img src={qrCode} alt="QR code for your authenticator app" />
                </div>
                <CopyField value={manualKey} label="Setup key" />
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
