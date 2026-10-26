import {type FormEvent, useEffect, useState} from "react";
import {useSubmit} from "@client/hooks/useSubmit";
import {apiFetch, canGrantRole, Role, useUser} from "toto-stack/client";
import {errorMessage} from "@client/lib/apiErrors";

type ListedUser = {
    id: number;
    username: string;
    roles: string[];
    otpEnabled: boolean;
    createdAt: string;
};

export function UsersSettings() {
    const {user} = useUser();
    const [users, setUsers] = useState<ListedUser[]>([]);
    const [loading, setLoading] = useState(true);
    const [listError, setListError] = useState<string | null>(null);
    const [revision, setRevision] = useState(0);
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [roleNames, setRoleNames] = useState("");
    const [success, setSuccess] = useState<string | null>(null);
    const [confirmId, setConfirmId] = useState<number | null>(null);
    const [deletingId, setDeletingId] = useState<number | null>(null);
    const {loading: pending, error, run} = useSubmit();

    function protectedReason(target: ListedUser): string | undefined {
        if (target.id === user?.id) return "You cannot delete your own account.";
        if (target.roles.includes(Role.OWNER)) return "Owner accounts cannot be deleted.";
        if (!target.roles.every(role => canGrantRole(user?.roles, role))) return "Only an owner can delete this user.";
        return undefined;
    }

    function deleteUser(target: ListedUser) {
        if (confirmId !== target.id || protectedReason(target)) return;
        void run(async () => {
            setSuccess(null);
            setDeletingId(target.id);
            try {
                await apiFetch(`/api/users/${target.id}`, {method: "DELETE"});
                setConfirmId(null);
                setSuccess("User deleted.");
                refresh();
            } finally {
                setDeletingId(null);
            }
        });
    }

    function createUser(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        void run(async () => {
            setSuccess(null);
            const roles = roleNames.split(",").map(role => role.trim()).filter(Boolean);
            const payload = {username: username.trim(), password, roles};
            setPassword("");
            if (!roles.every(role => canGrantRole(user?.roles, role))) {
                throw new Error("Only owners can grant owner or admin.");
            }
            await apiFetch("/api/users", {method: "POST", body: JSON.stringify(payload)});
            setUsername("");
            setRoleNames("");
            setSuccess("User created.");
            refresh();
        });
    }

    useEffect(() => {
        let active = true;
        void apiFetch<{users: ListedUser[]}>("/api/users").then(data => {
            if (active) setUsers(data.users);
        }).catch((error: unknown) => {
            if (active) setListError(errorMessage(error));
        }).finally(() => {
            if (active) setLoading(false);
        });
        return () => { active = false; };
    }, [revision]);

    function refresh() {
        setLoading(true);
        setListError(null);
        setRevision(value => value + 1);
    }

    return <section className="plate-panel settings-card" aria-labelledby="users-title">
        <h2 id="users-title">Users</h2>
        {listError && <div className="settings-feedback"><p role="alert">{listError}</p><button type="button" className="settings-button secondary" onClick={refresh}>Retry loading users</button></div>}
        {loading ? <p role="status">Loading users…</p> : !listError && <div className="settings-table-wrap">
            <table className="settings-table" aria-label="Users">
                <thead><tr><th scope="col">Username</th><th scope="col">Roles</th><th scope="col">MFA</th><th scope="col">Created</th><th scope="col">Actions</th></tr></thead>
                <tbody>{users.length === 0 && !listError && <tr><td colSpan={5}>No users found.</td></tr>}{users.map(target => <tr key={target.id}>
                    <th scope="row">{target.username}</th>
                    <td>{target.roles.map(role => <span className="status-pill" key={role}>{role}</span>)}</td>
                    <td>{target.otpEnabled ? "Enabled" : "Not enabled"}</td>
                    <td>{target.createdAt.slice(0, 10)}</td>
                    <td>{confirmId === target.id ? <div className="settings-danger">
                        <p id={`delete-user-${target.id}`}>Delete {target.username}? This also signs them out of all sessions.</p>
                        <div className="settings-actions">
                            <button type="button" className="settings-button settings-danger" aria-label={deletingId === target.id ? "Deleting…" : `Confirm delete ${target.username}`} aria-describedby={`delete-user-${target.id}`} disabled={pending || !!protectedReason(target)} onClick={() => deleteUser(target)}>{deletingId === target.id ? "Deleting…" : "Confirm delete"}</button>
                            <button type="button" className="settings-button secondary" disabled={pending} onClick={() => setConfirmId(null)}>Cancel</button>
                        </div>
                    </div> : <>
                        <button type="button" className="settings-button settings-danger" aria-label={`Delete ${target.username}`} aria-describedby={protectedReason(target) ? `protected-user-${target.id}` : undefined}
                            disabled={pending || !!protectedReason(target)} onClick={() => setConfirmId(target.id)}>Delete</button>
                        {protectedReason(target) && <p id={`protected-user-${target.id}`}>{protectedReason(target)}</p>}
                    </>}</td>
                </tr>)}</tbody>
            </table>
        </div>}
        <form className="settings-form" aria-labelledby="create-user-title" onSubmit={createUser} aria-busy={pending}>
            <h3 id="create-user-title">Create user</h3>
            <div className="form-field"><label htmlFor="users-username">Username</label>
                <input id="users-username" name="username" autoComplete="off" required maxLength={64} value={username} disabled={pending} onChange={event => setUsername(event.target.value)} /></div>
            <div className="form-field"><label htmlFor="users-password">Password</label>
                <input id="users-password" name="password" type="password" autoComplete="new-password" required minLength={10} maxLength={256} value={password} disabled={pending} onChange={event => setPassword(event.target.value)} aria-describedby="users-password-help" />
                <p id="users-password-help">Use 10–256 characters. The new user can change their password in Account.</p></div>
            <div className="form-field"><label htmlFor="users-roles">Roles</label>
                <input id="users-roles" name="roles" value={roleNames} disabled={pending} onChange={event => setRoleNames(event.target.value)} aria-describedby="users-roles-help" />
                <p id="users-roles-help">Enter comma-separated role names, or leave blank for no roles. The server validates names against configured roles. Only owners can grant owner or admin.</p></div>
            <div className="settings-actions"><button type="submit" className="settings-button" disabled={pending}>{pending && deletingId === null ? "Creating user…" : "Create user"}</button></div>
        </form>
        {error && <p className="settings-feedback" role="alert">{error}</p>}
        {success && <p className="settings-feedback success" role="status">{success}</p>}
    </section>;
}
