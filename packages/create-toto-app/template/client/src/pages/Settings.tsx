import "@client/styles/panels.css";
import "@client/styles/settings.css";
import {FaBell, FaDatabase, FaLock, FaUser, FaUsers} from "react-icons/fa";
import {Link, useSearchParams} from "react-router";
import {useUser} from "toto-stack/client";
import {hasAnyRole, Role} from "toto-stack/shared";
import {AccountSettings} from "@client/components/settings/AccountSettings";
import {MfaSettings} from "@client/components/settings/MfaSettings";
import {UsersSettings} from "@client/components/settings/UsersSettings";
import {NotificationsSettings} from "@client/components/settings/NotificationsSettings";
import {ServiceSettings} from "@client/components/settings/ServiceSettings";

const sections = [
    {id: "account", icon: <FaUser aria-hidden="true"/>, title: "Account", description: "Your identity, password and API access.", admin: false},
    {id: "security", icon: <FaLock aria-hidden="true"/>, title: "Security", description: "An extra layer of protection for your account.", admin: false},
    {id: "users", icon: <FaUsers aria-hidden="true"/>, title: "Users", description: "Manage the people who can access your app.", admin: true},
    {id: "notifications", icon: <FaBell aria-hidden="true"/>, title: "Notifications", description: "Send a message through your configured channels.", admin: true},
    {id: "service", icon: <FaDatabase aria-hidden="true"/>, title: "Service", description: "Check the health of your app and database.", admin: false},
];

export default function Settings() {
    const {user} = useUser();
    const [search] = useSearchParams();
    if (!user) return null;
    const available = sections.filter(section => !section.admin || hasAnyRole(user.roles, [Role.ADMIN]));
    const active = available.find(section => section.id === search.get("section")) ?? sections[0];
    return (
        <section className="page-container settings-page">
            <header className="page-header">
                <div>
                    <h1>Settings</h1>
                    <p className="page-subtitle">A little control. A lot of peace of mind.</p>
                </div>
                <span className="status-pill">Signed in securely</span>
            </header>
            <div className="settings-layout">
                <aside className="settings-rail">
                    <div className="settings-identity">
                        <span className="settings-avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span>
                        <div><strong>{user.username}</strong><span>{user.roles.join(", ") || "Member"}</span></div>
                    </div>
                    <nav className="settings-nav" aria-label="Settings sections">
                        {available.map(section => {
                            const params = new URLSearchParams(search);
                            params.set("section", section.id);
                            return <Link key={section.id} to={`?${params.toString()}`} aria-current={active.id === section.id ? "page" : undefined}>
                                {section.icon}<span>{section.title}</span>
                            </Link>;
                        })}
                    </nav>
                    <p className="settings-rail-note">Your account. Your controls.<br/>Changes are saved securely to the server.</p>
                </aside>
                <div className="settings-content" key={active.id}>
                    <div className="settings-section-header"><h2>{active.title}</h2><p>{active.description}</p></div>
                    {active.id === "account" && <AccountSettings/>}
                    {active.id === "security" && <MfaSettings/>}
                    {active.id === "users" && <UsersSettings/>}
                    {active.id === "notifications" && <NotificationsSettings/>}
                    {active.id === "service" && <ServiceSettings/>}
                </div>
            </div>
        </section>
    );
}
