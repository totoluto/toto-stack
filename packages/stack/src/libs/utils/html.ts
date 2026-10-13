const HTML_ESCAPES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
};

/** Escapes text for use in HTML element content and quoted attribute values. */
export function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, char => HTML_ESCAPES[char]);
}
