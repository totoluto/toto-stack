import {FormEvent, ReactNode, useState} from "react";
import {FaDesktop, FaMobileAlt, FaQuestionCircle, FaTabletAlt} from "react-icons/fa";
import {apiFetch} from "toto-stack/client";
import {useSubmit} from "@client/hooks/useSubmit";
import {useAccount} from "@client/hooks/useAccount";
import {CopyField} from "@client/components/CopyField";

function sessionDevice(userAgent: string | null) {
    const ua = userAgent ?? "";
    const device = /iPad|Tablet|Android(?!.*Mobile)/i.test(ua) ? "Tablet"
        : /Mobi|iPhone|Android/i.test(ua) ? "Phone"
        : /Windows|Macintosh|X11|CrOS|Linux/i.test(ua) ? "Computer" : "Unknown device";
    const Icon = device === "Tablet" ? FaTabletAlt : device === "Phone" ? FaMobileAlt : device === "Computer" ? FaDesktop : FaQuestionCircle;
    const browser = /Edg[eAiOS]*\//i.test(ua) ? "Edge" : /OPR\/|Opera/i.test(ua) ? "Opera"
        : /Firefox|FxiOS/i.test(ua) ? "Firefox" : /Chrome|CriOS/i.test(ua) ? "Chrome" : /Safari/i.test(ua) ? "Safari" : "";
    return {Icon, label: browser ? `${browser} · ${device}` : device};
}

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
    const {snapshot, loading, error, refresh} = useAccount();
    const [apiKey, setApiKey] = useState("");
    const [confirmRevoke, setConfirmRevoke] = useState(false);
    const [revoked, setRevoked] = useState(false);
    const revoke = useSubmit();
    const [selectedSession, setSelectedSession] = useState<string | null>(null);
    const [sessionRevoked, setSessionRevoked] = useState(false);
    if (!snapshot) return <div className="plate-panel settings-card">{error ? <><p className="settings-feedback" role="alert">{error}</p><button className="settings-button" disabled={loading} type="button" onClick={() => void refresh()}>Retry</button></> : <p role="status">Loading account…</p>}</div>;
    return <div className="settings-stack"><ActionForm title="Password" description="Use a unique password of 10–256 characters. Updating it signs out other sessions and revokes your API key." submitLabel="Update password" onSubmit={async form => {
        const data = new FormData(form);
        if (data.get("newPassword") !== data.get("confirmPassword")) throw new Error("The new passwords do not match.");
        await apiFetch("/api/account/password", {method: "POST", body: JSON.stringify({currentPassword: data.get("currentPassword"), newPassword: data.get("newPassword")})});
        setApiKey("");
        setConfirmRevoke(false);
        setSelectedSession(null);
        await refresh();
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
                await refresh();
                return "";
            }}>
                <label>Password for API key<input name="password" type="password" autoComplete="current-password" required maxLength={256}/></label>
            </ActionForm>
            <div className="settings-key-controls">
                <p>{snapshot.account.apiKeyEnabled ? "API key configured." : "No API key configured."}</p>
                {apiKey && <div className="settings-secret"><p className="settings-feedback success" role="status">API key generated. Save it before leaving this page.</p><CopyField label="New API key" value={apiKey}/><button className="settings-button secondary" type="button" onClick={() => setApiKey("")}>Hide API key</button></div>}
                {confirmRevoke ? <div className="settings-confirm">
                    <p>Revoke your API key? Applications using it will lose access immediately.</p>
                    <div className="settings-actions">
                        <button className="settings-button settings-danger" type="button" disabled={revoke.loading} onClick={() => void revoke.run(async () => {
                            await apiFetch("/api/account/api-key", {method: "DELETE"});
                            setApiKey("");
                            setRevoked(true);
                            setConfirmRevoke(false);
                            await refresh();
                        })}>{revoke.loading ? "Revoking…" : "Confirm revoke key"}</button>
                        <button className="settings-button secondary" type="button" disabled={revoke.loading} onClick={() => setConfirmRevoke(false)}>Cancel</button>
                    </div>
                </div> : snapshot.account.apiKeyEnabled && <button className="settings-button secondary" type="button" onClick={() => {setConfirmRevoke(true); setRevoked(false);}}>Revoke API key</button>}
                {revoke.error && <p className="settings-feedback" role="alert">{revoke.error}</p>}
                {revoked && <p className="settings-feedback success" role="status">API key revoked.</p>}
            </div>
        </div>
        <article className="plate-panel settings-card">
            <div className="settings-card-heading"><h2>Sessions</h2><p>Review your signed-in devices. Revoke any other session you no longer recognize.</p></div>
            <ul className="settings-session-list">
                {snapshot.sessions.map(session => {
                    const {Icon, label} = sessionDevice(session.userAgent);
                    return <li key={session.id}>
                        <Icon className="settings-session-icon" aria-hidden="true"/>
                        <div className="settings-session-info">
                            <div className="settings-session-heading"><strong>{label}</strong>{session.current && <span className="status-pill">Current session</span>}</div>
                            <p className="settings-session-meta">{session.ipAddress ?? "Unknown IP address"} · Last active <time dateTime={session.lastSeenAt}>{new Date(session.lastSeenAt).toLocaleString(undefined, {dateStyle: "short", timeStyle: "short"})}</time></p>
                            <details className="settings-session-details">
                                <summary>Details</summary>
                                <p>{session.userAgent ?? "Unknown device"}</p>
                                <p>Created: <time dateTime={session.createdAt}>{new Date(session.createdAt).toLocaleString()}</time></p>
                                <p>Expires: <time dateTime={session.expiresAt}>{new Date(session.expiresAt).toLocaleString()}</time></p>
                                {session.current && <p>Use Log out to end this session.</p>}
                            </details>
                        </div>
                        {!session.current && <button className="settings-button secondary" type="button" onClick={() => {setSelectedSession(session.id); setSessionRevoked(false);}}>Revoke session</button>}
                    </li>;
                })}
            </ul>
            {selectedSession && <ActionForm key={selectedSession} title="Revoke selected session" description="Confirm with your password. This device will lose access immediately." submitLabel="Confirm revoke session" onSubmit={async form => {
                if (!snapshot.sessions.some(session => session.id === selectedSession && !session.current)) throw new Error("Select another session.");
                await apiFetch("/api/account/revoke-session", {method: "POST", body: JSON.stringify({password: new FormData(form).get("password"), sessionID: selectedSession})});
                setSelectedSession(null);
                setSessionRevoked(true);
                await refresh();
                return "";
            }}>
                <label>Password for session<input name="password" type="password" autoComplete="current-password" required maxLength={256}/></label>
                <button className="settings-button secondary" type="button" onClick={() => setSelectedSession(null)}>Cancel</button>
            </ActionForm>}
            {sessionRevoked && <p className="settings-feedback success" role="status">Session revoked.</p>}
        </article>
    </div>;
}
