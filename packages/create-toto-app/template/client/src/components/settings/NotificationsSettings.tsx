import {useCallback, useEffect, useState, type FormEvent} from "react";
import {ApiError, apiFetch, ErrorCode} from "toto-stack/client";
import {useSubmit} from "@client/hooks/useSubmit";

type DeliveryResult = {handler: string; ok: boolean};
type Delivery = {delivered: number; failed: number; results: DeliveryResult[]};

// Access is gated by the parent settings page; the API also enforces admin access.
export function NotificationsSettings() {
    const [handlers, setHandlers] = useState<string[]>([]);
    const [selected, setSelected] = useState<string[]>([]);
    const [title, setTitle] = useState("");
    const [message, setMessage] = useState("");
    const [delivery, setDelivery] = useState<Delivery | null>(null);
    const {loading, error, run} = useSubmit();
    const send = useSubmit();

    const loadHandlers = useCallback(() => {
        void run(async () => {
            const result = await apiFetch<{handlers: string[]}>("/api/notifications/handlers");
            setHandlers(result.handlers);
            setSelected(previous => previous.filter(handler => result.handlers.includes(handler)));
        });
    }, [run]);

    useEffect(loadHandlers, [loadHandlers]);

    const pending = loading || send.loading;
    const recipients = selected.filter(handler => handlers.includes(handler));
    const canSend = !pending && recipients.length > 0 && title.trim().length > 0 && message.trim().length > 0;

    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        // An empty array broadcasts on the server: never submit without explicit recipients.
        if (!canSend) return;
        void send.run(async () => {
            setDelivery(null);
            try {
                const result = await apiFetch<Delivery>("/api/notifications/send", {
                    method: "POST",
                    body: JSON.stringify({title: title.trim(), message: message.trim(), handlers: recipients}),
                });
                setDelivery(result);
            } catch (error) {
                if (error instanceof ApiError && error.code === ErrorCode.DELIVERY_FAILED) {
                    const details = error.details as {results?: DeliveryResult[]} | undefined;
                    if (Array.isArray(details?.results)) {
                        setDelivery({delivered: 0, failed: details.results.length, results: details.results});
                    }
                }
                throw error;
            }
        });
    }

    return (
        <section className="plate-panel settings-card" aria-labelledby="notifications-heading">
            <h2 id="notifications-heading">Notifications</h2>
            <p>Send a notification through the configured handlers. Select each recipient explicitly.</p>
            {loading && <p className="settings-feedback" role="status">Loading handlers…</p>}
            {error && <p className="settings-feedback" role="alert">{error}</p>}
            {!loading && !error && handlers.length === 0 && <p className="settings-feedback" role="status">No notification handlers are configured.</p>}
            <form className="settings-form" onSubmit={submit} aria-label="Send notification">
                <fieldset disabled={pending || handlers.length === 0}>
                    <legend>Notification handlers</legend>
                    {handlers.map(handler => <label key={handler}>
                        <input type="checkbox" checked={selected.includes(handler)} onChange={event => {
                            setSelected(previous => event.target.checked ? [...previous, handler] : previous.filter(id => id !== handler));
                        }} />
                        {handler}
                    </label>)}
                </fieldset>
                <label htmlFor="notification-title">Title</label>
                <input id="notification-title" value={title} onChange={event => setTitle(event.target.value)} maxLength={200} required disabled={pending} />
                <label htmlFor="notification-message">Message</label>
                <textarea id="notification-message" value={message} onChange={event => setMessage(event.target.value)} maxLength={2000} required disabled={pending} />
                <div className="settings-actions">
                    <button className="settings-button" type="submit" disabled={!canSend}>{send.loading ? "Sending…" : "Send notification"}</button>
                    <button className="settings-button secondary" type="button" onClick={loadHandlers} disabled={pending}>Retry handlers</button>
                </div>
            </form>
            {send.error && <p className="settings-feedback" role="alert">{send.error}</p>}
            {delivery && <div className={`settings-feedback ${delivery.failed ? "warning" : "success"}`} role="status">
                <p>{delivery.delivered} delivered, {delivery.failed} failed.</p>
                <ul>{delivery.results.map(result => <li key={result.handler}>
                    {result.handler}: {result.ok ? "Delivered" : "Failed"}
                </li>)}</ul>
            </div>}
        </section>
    );
}
