import {useState} from "react";
import {useSubmit} from "@client/hooks/useSubmit";

type Health = {status: "ok" | "degraded"; db: "ok" | "down"; uptimeSeconds: number};

export function ServiceSettings() {
    const [health, setHealth] = useState<Health | null>(null);
    const {loading, error, run} = useSubmit();

    function checkHealth() {
        void run(async () => {
            setHealth(null);
            const response = await fetch("/api/health", {method: "GET", credentials: "same-origin"});
            if (!response.ok && response.status !== 503) throw new Error(`Health check failed (HTTP ${response.status}). Please try again.`);
            const result = await response.json();
            if (!result || !["ok", "degraded"].includes(result.status) || !["ok", "down"].includes(result.db)
                || typeof result.uptimeSeconds !== "number" || !Number.isFinite(result.uptimeSeconds) || result.uptimeSeconds < 0) {
                throw new Error("Unexpected health response. Please try again.");
            }
            setHealth(result);
        });
    }

    return (
        <section className="plate-panel settings-card" aria-labelledby="service-heading">
            <h2 id="service-heading">Service health</h2>
            <p>Check readiness, database connectivity and server uptime on demand.</p>
            <div className="settings-actions">
                <button className="settings-button secondary" type="button" onClick={checkHealth} disabled={loading}>
                    {loading ? "Checking health…" : "Check health"}
                </button>
            </div>
            {error && <p className="settings-feedback" role="alert">{error}</p>}
            {health && <div className={`settings-feedback ${health.status === "ok" && health.db === "ok" ? "success" : "warning"}`} role="status">
                <dl>
                    <dt>Status</dt><dd><span className="status-pill" aria-label="Service status">{health.status}</span></dd>
                    <dt>Database</dt><dd aria-label="Database status">{health.db}</dd>
                    <dt>Uptime</dt><dd>{health.uptimeSeconds} seconds</dd>
                </dl>
            </div>}
        </section>
    );
}
