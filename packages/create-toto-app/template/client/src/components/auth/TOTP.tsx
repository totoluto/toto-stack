import {ClipboardEvent, KeyboardEvent, useEffect, useRef} from "react";

type TOTPProps = {
    length?: number;
    /** Entered digits, contiguous from the first box (no gaps). */
    value: string;
    onChange: (otp: string) => void;
    /** Called once with the full code as soon as every box is filled. */
    onComplete?: (otp: string) => void;
    disabled?: boolean;
};

/**
 * One-time-code input rendered as one box per digit. Behaves like a single
 * text field: typing advances, Backspace clears and goes back, the arrow keys
 * move between boxes, and pasting or autofilling a whole code (also into the
 * first box, as iOS does) fills every box. Non-digits are ignored.
 */
export function TOTP({length = 6, value, onChange, onComplete, disabled}: TOTPProps) {
    const inputsRef = useRef<(HTMLInputElement | null)[]>([]);
    // The current code, updated synchronously by every edit. Focus moves
    // within the same event, before React re-renders with the new `value`,
    // so the handlers read this instead of the (stale) prop.
    const codeRef = useRef(value);
    // The complete code onComplete last fired for: no second call for the same code.
    const completedRef = useRef<string | null>(null);
    const wasDisabledRef = useRef(disabled);

    useEffect(() => {
        // Changes made by the parent, e.g. a reset after a wrong code.
        codeRef.current = value;
        if (value.length < length) completedRef.current = null;
    }, [value, length]);

    useEffect(() => {
        // The boxes are disabled while a code is verified; afterwards, put the cursor back.
        if (wasDisabledRef.current && !disabled) {
            inputsRef.current[Math.min(codeRef.current.length, length - 1)]?.focus();
        }
        wasDisabledRef.current = disabled;
    }, [disabled, length]);

    function focusBox(index: number) {
        inputsRef.current[Math.max(0, Math.min(index, length - 1))]?.focus();
    }

    function commit(next: string, focusIndex: number) {
        const code = next.replace(/\D/g, "").slice(0, length);
        codeRef.current = code;
        onChange(code);
        focusBox(focusIndex);

        if (code.length < length) {
            completedRef.current = null;
        } else if (completedRef.current !== code) {
            completedRef.current = code;
            // Pass the new code explicitly: the parent's state hasn't updated yet.
            onComplete?.(code);
        }
    }

    function handleChange(index: number, raw: string) {
        const code = codeRef.current;
        const start = Math.min(index, code.length);

        if (raw === "") {
            // Box emptied (Delete, cut): remove its digit.
            commit(code.slice(0, start) + code.slice(start + 1), start);
            return;
        }

        let typed = raw.replace(/\D/g, "");
        // Only non-digits: ignore them (React restores the box's value).
        if (!typed) return;

        // Typing into a filled box whose digit wasn't selected keeps the old
        // digit next to the new input; drop it. A whole code replacing the
        // selected digit (autofill) has exactly `length` digits.
        const previous = code[start];
        if (previous && typed.length > 1 && typed.length !== length) {
            typed = typed[0] === previous ? typed.slice(1) : typed.slice(0, -1);
        }

        if (typed.length >= length) {
            // A whole code (autofill, e.g. iOS SMS codes into the first box).
            commit(typed, length - 1);
            return;
        }

        commit(code.slice(0, start) + typed + code.slice(start + typed.length), start + typed.length);
    }

    function handleKeyDown(index: number, e: KeyboardEvent<HTMLInputElement>) {
        const code = codeRef.current;

        if (e.key === "Backspace") {
            e.preventDefault();
            if (index < code.length) {
                // Clear this box and move back.
                commit(code.slice(0, index) + code.slice(index + 1), index - 1);
            } else if (index > 0) {
                // Empty box: clear the previous one.
                commit(code.slice(0, index - 1) + code.slice(index), index - 1);
            }
        } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            focusBox(index - 1);
        } else if (e.key === "ArrowRight") {
            e.preventDefault();
            focusBox(Math.min(index + 1, code.length));
        }
    }

    function handlePaste(index: number, e: ClipboardEvent<HTMLInputElement>) {
        const pasted = e.clipboardData.getData("text").replace(/\D/g, "");
        e.preventDefault();
        if (!pasted) return;

        if (pasted.length >= length) {
            commit(pasted, length - 1);
            return;
        }

        const code = codeRef.current;
        const start = Math.min(index, code.length);
        commit(code.slice(0, start) + pasted + code.slice(start + pasted.length), start + pasted.length);
    }

    return (
        <div className="otp-field" role="group" aria-label="Authentication code">
            {Array.from({length}, (_, i) => (
                <input
                    key={i}
                    ref={(el) => {
                        inputsRef.current[i] = el;
                    }}
                    // No maxLength: autofill puts the whole code into one box.
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete={i === 0 ? "one-time-code" : "off"}
                    autoFocus={i === 0}
                    aria-label={`Digit ${i + 1} of ${length}`}
                    value={value[i] ?? ""}
                    disabled={disabled}
                    onFocus={(e) => {
                        // Boxes fill left to right; jump to the first empty one.
                        const filled = codeRef.current.length;
                        if (i > filled) focusBox(filled);
                        else e.target.select();
                    }}
                    onChange={(e) => handleChange(i, e.target.value)}
                    onKeyDown={(e) => handleKeyDown(i, e)}
                    onPaste={(e) => handlePaste(i, e)}
                    className={i === Math.floor(length / 2) - 1 ? "space" : undefined}
                />
            ))}
        </div>
    );
}
