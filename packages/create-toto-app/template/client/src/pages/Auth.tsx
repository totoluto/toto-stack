import {UserAuthState, UserStatusType} from "toto-stack/shared";
import {LoginForm} from "@client/components/auth/LoginForm";
import {useUser} from "toto-stack/client";
import {useState} from "react";
import {SetupForm} from "@client/components/auth/SetupForm";
import {TOTPSetupForm} from "@client/components/auth/TOTPSetupForm";
import {TOTPLoginForm} from "@client/components/auth/TOTPLoginForm";
import '@client/styles/login.css';

type AuthResponse = (UserStatusType & { qrCode: string; key: string; }) |
    (UserStatusType & { authState: Exclude<UserAuthState, UserAuthState.SETUP_VERIFY> });

export function AuthComponent() {
    const {setUser, authStage, setAuthStage} = useUser();
    const [qrCode, setQrCode] = useState<string>("");
    const [key, setKey] = useState<string>("");

    function handleSuccess(userStatus: AuthResponse) {
        if (userStatus.user) {
            setUser(userStatus.user);
        }

        if (userStatus.authState === UserAuthState.SETUP_VERIFY) {
            setQrCode(userStatus.qrCode);
            setKey(userStatus.key);
        }

        setAuthStage(userStatus.authState);
    }

    switch (authStage) {
        case UserAuthState.LOGIN:
            return <LoginForm<AuthResponse> onSuccess={handleSuccess} />;
        case UserAuthState.SETUP:
            return <SetupForm<AuthResponse> onSuccess={handleSuccess} />;
        case UserAuthState.SETUP_VERIFY:
            return (
                <TOTPSetupForm<AuthResponse>
                    qrCode={qrCode}
                    manualKey={key}
                    onSuccess={handleSuccess}
                />
            );
        case UserAuthState.OTP:
            return <TOTPLoginForm<AuthResponse> onSuccess={handleSuccess} />;
        default:
            return null;
    }
}
