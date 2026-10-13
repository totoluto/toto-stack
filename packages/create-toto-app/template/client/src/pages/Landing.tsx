import { Link, Navigate } from "react-router";
import { useUser } from "toto-stack/client";
import { UserAuthState } from "toto-stack/shared";
import "@client/styles/landing.css";
import { FaShieldAlt, FaBell, FaBox, FaCode, FaLightbulb, FaRocket } from "react-icons/fa";

export default function Landing() {
  const { authStage } = useUser();

  if (authStage === UserAuthState.AUTHENTICATED) {
    return <Navigate to="/admin" replace />;
  }

  return (
    <div className="landing-wrapper">
      <div className="landing-hero">
        <div className="hero-content">
          <h1 className="hero-title">Stack</h1>
          <p className="hero-subtitle">Production-ready foundation for modern SaaS applications</p>
          <p className="hero-description">
            Minimalist, secure-by-design, fully typed. Build faster with battle-tested infrastructure.
          </p>
          <Link className="hero-cta" to="/login">
            Sign in
          </Link>
        </div>
      </div>

      <div className="landing-features">
        <div className="features-container">
          <div className="feature-card">
            <div className="feature-icon" aria-hidden="true">
              <FaShieldAlt size={24} />
            </div>
            <h3>Security First</h3>
            <p>Session-based auth with MFA, role-based access control, rate limiting</p>
          </div>

          <div className="feature-card">
            <div className="feature-icon" aria-hidden="true">
              <FaBell size={24} />
            </div>
            <h3>Multi-Channel</h3>
            <p>Email, Discord, Slack, Telegram notifications with webhook support</p>
          </div>

          <div className="feature-card">
            <div className="feature-icon" aria-hidden="true">
              <FaBox size={24} />
            </div>
            <h3>Production Ready</h3>
            <p>Docker Compose, error handling, database migrations, all included</p>
          </div>

          <div className="feature-card">
            <div className="feature-icon" aria-hidden="true">
              <FaCode size={24} />
            </div>
            <h3>Full TypeScript</h3>
            <p>End-to-end type safety from database to frontend</p>
          </div>

          <div className="feature-card">
            <div className="feature-icon" aria-hidden="true">
              <FaLightbulb size={24} />
            </div>
            <h3>Highly Extensible</h3>
            <p>Composable routing, base patterns, easy to add features</p>
          </div>

          <div className="feature-card">
            <div className="feature-icon" aria-hidden="true">
              <FaRocket size={24} />
            </div>
            <h3>Tech Stack</h3>
            <p>React, Express, Prisma, MariaDB. Minimal dependencies, maximum control</p>
          </div>
        </div>
      </div>

      <div className="landing-footer-section">
        <div className="footer-content">
          <h2>Ready to build?</h2>
          <p>Start with Stack and focus on your product, not the infrastructure</p>
          <Link className="footer-cta" to="/login">
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
