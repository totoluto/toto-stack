import {FormEvent, useState} from "react";
import {apiFetch} from "toto-stack/client";
import {CopyField} from "@client/components/CopyField";
import {useSubmit} from "@client/hooks/useSubmit";

type Enrollment = {qrCode: string; key: string};

export function MfaSettings() {
    const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
    const [disabling, setDisabling] = useState(false);
    const [message, setMessage] = useState("");
    const {loading, error, setError, run} = useSubmit();

    function submit(event: FormEvent<HTMLFormElement>, path: string, success: string) {
        event.preventDefault();
        const form = event.currentTarget;
        const data = Object.fromEntries(new FormData(form));
        void run(async () => {
            setMessage("");
            if (path === "start") {
                setEnrollment(await apiFetch<Enrollment>("/api/account/mfa/start", {method: "POST", body: JSON.stringify(data)}));
            } else {
                await apiFetch(`/api/account/mfa/${path}`, {method: "POST", body: JSON.stringify(data)});
                setEnrollment(null);
                setDisabling(false);
                setMessage(success);
            }
            form.reset();
        });
    }

    function cancel() {
        setEnrollment(null);
        setDisabling(false);
        setError(null);
    }

    return <article className="plate-panel settings-card">
        <div className="settings-card-heading"><h2>Two-factor authentication</h2>
            <p>Add a second layer of protection with an authenticator app. Changes sign out your other sessions.</p>
        </div>
        <p className="settings-hint">Your current two-factor status is not exposed by the account API. Set up an authenticator if it is off, or use your existing code to turn it off.</p>
        {enrollment ? <form className="settings-form" onSubmit={event => submit(event, "verify", "Two-factor authentication enabled. Other sessions have been signed out.")}>
            <p>Scan this code in your authenticator app, then enter its six-digit code. Setup expires after 10 minutes.</p>
            <img className="settings-qr" src={enrollment.qrCode} alt="Scan with your authenticator app"/>
            <CopyField label="Manual setup key" value={enrollment.key}/>
            <label>Authenticator code<input name="token" type="text" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} autoComplete="one-time-code" required disabled={loading}/></label>
            <div className="settings-actions">
                <button className="settings-button" disabled={loading} type="submit">{loading ? "Verifying…" : "Enable two-factor authentication"}</button>
                <button className="settings-button secondary" disabled={loading} type="button" onClick={cancel}>Cancel setup</button>
            </div>
        </form> : disabling ? <form className="settings-form settings-confirm" onSubmit={event => submit(event, "disable", "Two-factor authentication disabled. Other sessions have been signed out.")}>
            <p>Turning this off removes your second sign-in factor. Confirm with your password and a fresh authenticator code.</p>
            <fieldset disabled={loading}>
                <label>Password to turn off two-factor<input name="password" type="password" autoComplete="current-password" required maxLength={256}/></label>
                <label>Current authenticator code<input name="token" type="text" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} autoComplete="one-time-code" required/></label>
            </fieldset>
            <div className="settings-actions">
                <button className="settings-button settings-danger" disabled={loading} type="submit">{loading ? "Updating…" : "Confirm turn off"}</button>
                <button className="settings-button secondary" disabled={loading} type="button" onClick={cancel}>Cancel</button>
            </div>
        </form> : <form className="settings-form" onSubmit={event => submit(event, "start", "")}>
            <label>Password for two-factor authentication<input name="password" type="password" autoComplete="current-password" required maxLength={256} disabled={loading}/></label>
            <div className="settings-actions">
                <button className="settings-button" disabled={loading} type="submit">{loading ? "Starting…" : "Set up authenticator"}</button>
                <button className="settings-button secondary" disabled={loading} type="button" onClick={() => {setDisabling(true); setMessage(""); setError(null);}}>Turn off two-factor authentication</button>
            </div>
        </form>}
        {error && <p className="settings-feedback" role="alert">{error}</p>}
        {message && <p className="settings-feedback success" role="status">{message}</p>}
    </article>;
}
