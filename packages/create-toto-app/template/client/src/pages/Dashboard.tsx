import { useUser } from "toto-stack/client";
import "@client/styles/panels.css";
import { FaUser, FaShieldAlt, FaCog } from "react-icons/fa";

export default function Dashboard() {
  const { user } = useUser();

  if (!user) {
    return (
      <section className="page-container">
        <div className="empty-state">
          <p>Loading user data...</p>
        </div>
      </section>
    );
  }

  const roles = user.roles?.length > 0 ? user.roles.join(", ") : "User";

  return (
    <section className="page-container">
      <header className="page-header">
        <div>
          <h1>Welcome, {user.username}</h1>
          <div className="page-meta">
            <span>Dashboard</span>
            <span aria-hidden="true">·</span>
            <span>Authenticated</span>
          </div>
        </div>
      </header>

      <div className="dashboard-grid">
        <article className="plate-panel">
          <div className="panel-header">
            <FaUser size={24} aria-hidden="true" />
            <h2>Account</h2>
          </div>
          <div className="compact-list">
            <div className="compact-row">
              <strong>User ID</strong>
              <span>{user.id}</span>
            </div>
            <div className="compact-row">
              <strong>Username</strong>
              <span>{user.username}</span>
            </div>
            <div className="compact-row">
              <strong>Roles</strong>
              <span>{roles}</span>
            </div>
          </div>
        </article>

        <article className="plate-panel">
          <div className="panel-header">
            <FaShieldAlt size={24} aria-hidden="true" />
            <h2>Security</h2>
          </div>
          <div className="compact-list">
            <div className="compact-row">
              <strong>Status</strong>
              <span className="status-active">
                Authenticated
              </span>
            </div>
            <div className="compact-row">
              <strong>Session</strong>
              <span>Active</span>
            </div>
          </div>
        </article>

        <article className="plate-panel" style={{ gridColumn: "1 / -1" }}>
          <div className="panel-header">
            <FaCog size={24} aria-hidden="true" />
            <h2>Getting Started</h2>
          </div>
          <div className="compact-list">
            <div className="compact-row">
              <strong>✓ Account Created</strong>
              <span>Your account is set up and ready to use.</span>
            </div>
            <div className="compact-row">
              <strong>✓ Authentication Configured</strong>
              <span>Password sign-in with mandatory TOTP two-factor authentication.</span>
            </div>
            <div className="compact-row">
              <strong>→ Build your app</strong>
              <span>Add API routes in server/index.ts and pages in client/src/AppRoutes.tsx.</span>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}
