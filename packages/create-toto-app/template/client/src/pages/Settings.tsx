import "@client/styles/panels.css";
import "@client/styles/settings.css";
import {FaBell, FaDatabase, FaLock, FaUserShield} from "react-icons/fa";

const sections = [
    {
        icon: <FaUserShield aria-hidden="true"/>,
        title: "Account",
        description: "User profile, roles and sign-in controls will live here.",
    },
    {
        icon: <FaBell aria-hidden="true"/>,
        title: "Notifications",
        description: "Delivery channels and routing rules for future alerts.",
    },
    {
        icon: <FaDatabase aria-hidden="true"/>,
        title: "Data",
        description: "Retention, cleanup and export controls for operational data.",
    },
    {
        icon: <FaLock aria-hidden="true"/>,
        title: "Security",
        description: "Access boundaries and audit-facing controls.",
    },
];

export default function Settings() {
    return (
        <section className="page-container">
            <header className="page-header">
                <div>
                    <h1>Settings</h1>
                    <div className="page-meta">
                        <span>Console preferences</span>
                        <span aria-hidden="true">·</span>
                        <span>Admin surface</span>
                    </div>
                </div>
            </header>

            <div className="settings-grid">
                {sections.map((section) => (
                    <article className="plate-panel settings-tile" key={section.title}>
                        <div className="settings-tile-icon">{section.icon}</div>
                        <div>
                            <h2>{section.title}</h2>
                            <p>{section.description}</p>
                        </div>
                    </article>
                ))}
            </div>
        </section>
    );
}
