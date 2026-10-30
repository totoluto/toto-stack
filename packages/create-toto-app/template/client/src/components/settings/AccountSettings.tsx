import {FormEvent, ReactNode, useState} from "react";
import {apiFetch} from "toto-stack/client";
import {useSubmit} from "@client/hooks/useSubmit";
import {CopyField} from "@client/components/CopyField";

function ActionForm({title, description, submitLabel, onSubmit, children}: {
    title: string;
    description: string;
    submitLabel: string;
    onSubmit: (form: HTMLFormElement) => Promise<string>;
    children: ReactNode;
}) {
    const {loading, error, run} = useSubmit();
    const [success, setSuccess] = useState("");
    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = event.currentTarget;
        void run(async () => {
            setSuccess("");
            setSuccess(await onSubmit(form));
            form.reset();
        });
    }
    return <article className="plate-panel settings-card">
        <div className="settings-card-heading"><h2>{title}</h2><p>{description}</p></div>
        <form className="settings-form" onSubmit={submit}>
            <fieldset disabled={loading}>{children}</fieldset>
            {error && <p className="settings-feedback" role="alert">{error}</p>}
            {success && <p className="settings-feedback success" role="status">{success}</p>}
            <div className="settings-actions"><button className="settings-button" disabled={loading} type="submit">{loading ? "Saving…" : submitLabel}</button></div>
        </form>
    </article>;
}

export function AccountSettings() {
    const [apiKey, setApiKey] = useState("");
    const [confirmRevoke, setConfirmRevoke] = useState(false);
    const [revoked, setRevoked] = useState(false);
    const revoke = useSubmit();
    return <div className="settings-stack"><ActionForm title="Password" description="Use a unique password of 10–256 characters. Updating it signs out other sessions and revokes your API key." submitLabel="Update password" onSubmit={async form => {
        const data = new FormData(form);
        if (data.get("newPassword") !== data.get("confirmPassword")) throw new Error("The new passwords do not match.");
        await apiFetch("/api/account/password", {method: "POST", body: JSON.stringify({currentPassword: data.get("currentPassword"), newPassword: data.get("newPassword")})});
        setApiKey("");
        return "Password updated. Other sessions are signed out and your API key is revoked.";
    }}>
        <label>Current password<input name="currentPassword" type="password" autoComplete="current-password" required maxLength={256}/></label>
        <label>New password<input name="newPassword" type="password" autoComplete="new-password" required minLength={10} maxLength={256}/></label>
        <label>Confirm new password<input name="confirmPassword" type="password" autoComplete="new-password" required minLength={10} maxLength={256}/></label>
    </ActionForm>
        <div className="plate-panel settings-stack settings-key-card">
            <ActionForm title="API key" description="Generate a key for API access. This immediately replaces any previous key. Copy it somewhere safe: it is only shown once and is never saved in your browser." submitLabel="Generate API key" onSubmit={async form => {
                const {apiKey: nextKey} = await apiFetch<{apiKey: string}>("/api/account/api-key", {method: "POST", body: JSON.stringify({password: new FormData(form).get("password")})});
                setApiKey(nextKey);
                setRevoked(false);
                return "";
            }}>
                <label>Password for API key<input name="password" type="password" autoComplete="current-password" required maxLength={256}/></label>
            </ActionForm>
            <div className="settings-key-controls">
                {apiKey && <div className="settings-secret"><p className="settings-feedback success" role="status">API key generated. Save it before leaving this page.</p><CopyField label="New API key" value={apiKey}/><button className="settings-button secondary" type="button" onClick={() => setApiKey("")}>Hide API key</button></div>}
                {confirmRevoke ? <div className="settings-confirm">
                    <p>Revoke your API key? Applications using it will lose access immediately.</p>
                    <div className="settings-actions">
                        <button className="settings-button settings-danger" type="button" disabled={revoke.loading} onClick={() => void revoke.run(async () => {
                            await apiFetch("/api/account/api-key", {method: "DELETE"});
                            setApiKey("");
                            setRevoked(true);
                            setConfirmRevoke(false);
                        })}>{revoke.loading ? "Revoking…" : "Confirm revoke key"}</button>
                        <button className="settings-button secondary" type="button" disabled={revoke.loading} onClick={() => setConfirmRevoke(false)}>Cancel</button>
                    </div>
                </div> : <button className="settings-button secondary" type="button" onClick={() => {setConfirmRevoke(true); setRevoked(false);}}>Revoke API key</button>}
                {revoke.error && <p className="settings-feedback" role="alert">{revoke.error}</p>}
                {revoked && <p className="settings-feedback success" role="status">API key revoked.</p>}
            </div>
        </div>
        <ActionForm title="Sessions" description="Revoke a session when you know its ID. The core API does not expose a session list. To end all other sessions, update your password. Revoking this session signs you out on your next request." submitLabel="Revoke session" onSubmit={async form => {
            const data = new FormData(form);
            await apiFetch("/api/account/revoke-session", {method: "POST", body: JSON.stringify({password: data.get("password"), sessionID: data.get("sessionID")})});
            return "Session revocation requested. The session ID must belong to your account.";
        }}>
            <label>Session ID<input name="sessionID" type="text" autoComplete="off" required/></label>
            <label>Password for session<input name="password" type="password" autoComplete="current-password" required maxLength={256}/></label>
        </ActionForm>
    </div>;
}
