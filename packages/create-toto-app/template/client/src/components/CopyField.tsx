import {useEffect, useId, useState} from "react";
import {LuCopy, LuCopyCheck} from "react-icons/lu";

type CopyFieldProps = {
    value: string;
    label?: string;
};

export function CopyField({value, label}: CopyFieldProps) {
    const id = useId();
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!copied) return;
        const timer: ReturnType<typeof setTimeout> = setTimeout(() => setCopied(false), 1500);
        return () => clearTimeout(timer);
    }, [copied]);

    async function copy() {
        try {
            await navigator.clipboard.writeText(value);
        } catch {
            const textarea = document.createElement("textarea");
            textarea.value = value;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand("copy");
            document.body.removeChild(textarea);
        }

        setCopied(true);
    }

    return (
        <div className="copy-field-wrapper">
            {label && <label htmlFor={id}>{label}</label>}
            <div className="copy-field">
                <input
                    id={id}
                    type="text"
                    value={value}
                    readOnly
                    onFocus={(e) => e.target.select()}
                />
                <button
                    type="button"
                    onClick={copy}
                    aria-label={copied ? "Copied" : `Copy ${label ?? "value"} to clipboard`}
                >
                    {copied ? <LuCopyCheck aria-hidden="true" /> : <LuCopy aria-hidden="true" />}
                </button>
            </div>
            <span className="sr-only" aria-live="polite">{copied ? "Copied to clipboard" : ""}</span>
        </div>
    );
}
