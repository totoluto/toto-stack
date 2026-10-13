// @vitest-environment happy-dom
// The scaffolded app's one-time-code input (template/client/src/components/auth/TOTP.tsx)
// and the forms that auto-submit with it.
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createElement as h, useState} from "react";
import {act, cleanup, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {clearCsrfToken, UserContext, type UserContextType} from "toto-stack/client";
import {UserAuthState} from "toto-stack/shared";
import {TOTP} from "@client/components/auth/TOTP";
import {TOTPLoginForm} from "@client/components/auth/TOTPLoginForm";
import {TOTPSetupForm} from "@client/components/auth/TOTPSetupForm";

afterEach(cleanup);

type HarnessProps = {onComplete?: (code: string) => void; disabled?: boolean; initial?: string};

let resetHarness: () => void = () => undefined;

/** A parent owning the code state, like the forms. */
function Harness({onComplete, disabled, initial = ""}: HarnessProps) {
    const [otp, setOtp] = useState(initial);
    resetHarness = () => setOtp("");
    return h("div", null,
        h(TOTP, {value: otp, onChange: setOtp, onComplete, disabled}),
        h("output", {"data-testid": "state"}, otp),
        h("button", {type: "button"}, "elsewhere"));
}

const boxes = () => within(screen.getByRole("group", {name: "Authentication code"})).getAllByRole("textbox") as HTMLInputElement[];
const values = () => boxes().map(box => box.value).join("");
const state = () => screen.getByTestId("state").textContent;
const focused = () => boxes().indexOf(document.activeElement as HTMLInputElement);

/**
 * What a browser does when a key is typed into the focused box: keydown,
 * then the new text (replacing the selection, or inserted at the caret).
 */
function type(text: string) {
    for (const char of text) {
        const input = document.activeElement as HTMLInputElement;
        const {selectionStart, selectionEnd, value} = input;
        const start = selectionStart ?? value.length;
        const end = selectionEnd ?? value.length;
        const notCancelled = fireEvent.keyDown(input, {key: char});
        expect(notCancelled).toBe(true); // typing a character is never blocked
        fireEvent.change(input, {target: {value: value.slice(0, start) + char + value.slice(end)}});
    }
}

function press(key: string) {
    fireEvent.keyDown(document.activeElement as HTMLInputElement, {key});
}

function paste(input: HTMLInputElement, text: string) {
    fireEvent.paste(input, {clipboardData: {getData: () => text}});
}

describe("TOTP input", () => {
    it("fills successive boxes when typing digit by digit, moving the focus forward", () => {
        const onComplete = vi.fn();
        render(h(Harness, {onComplete}));
        expect(focused()).toBe(0);

        for (const [i, digit] of [..."12345"].entries()) {
            type(digit);
            expect(values()).toBe("12345".slice(0, i + 1));
            expect(focused()).toBe(i + 1);
        }
        expect(onComplete).not.toHaveBeenCalled();

        type("6");
        expect(values()).toBe("123456");
        expect(state()).toBe("123456");
        expect(focused()).toBe(5);
        expect(onComplete).toHaveBeenCalledTimes(1);
        expect(onComplete).toHaveBeenCalledWith("123456");
    });

    it("Backspace clears the current box and moves back; on an empty box it clears the previous one", () => {
        render(h(Harness));
        type("1234");
        expect(focused()).toBe(4); // the first empty box

        press("Backspace");
        expect(values()).toBe("123");
        expect(focused()).toBe(3);

        press("Backspace");
        expect(values()).toBe("12");
        expect(focused()).toBe(2);

        // On a filled box: clear it and go back.
        boxes()[1].focus();
        press("Backspace");
        expect(values()).toBe("1");
        expect(focused()).toBe(0);

        press("Backspace");
        expect(values()).toBe("");
        expect(focused()).toBe(0);

        press("Backspace"); // nothing left: no-op
        expect(values()).toBe("");
        expect(focused()).toBe(0);
    });

    it("moves between boxes with the arrow keys, never past the first empty box", () => {
        render(h(Harness));
        type("123");

        press("ArrowLeft");
        expect(focused()).toBe(2);
        press("ArrowLeft");
        press("ArrowLeft");
        press("ArrowLeft");
        expect(focused()).toBe(0);

        press("ArrowRight");
        expect(focused()).toBe(1);
        press("ArrowRight");
        press("ArrowRight");
        press("ArrowRight");
        expect(focused()).toBe(3);

        // Typing over a selected digit replaces it and advances.
        boxes()[1].focus();
        type("9");
        expect(values()).toBe("193");
        expect(focused()).toBe(2);
    });

    it("keeps only the new digit when typing into a filled box whose digit isn't selected", () => {
        render(h(Harness, {initial: "123"}));
        const second = boxes()[1];
        second.focus();

        // Caret after the existing digit, then before it.
        fireEvent.change(second, {target: {value: "27"}});
        expect(values()).toBe("173");
        second.focus();
        fireEvent.change(second, {target: {value: "57"}});
        expect(values()).toBe("153");
    });

    it("jumps to the first empty box when an empty box further right is clicked", () => {
        render(h(Harness));
        type("12");

        boxes()[5].focus();
        expect(focused()).toBe(2);
        type("3");
        expect(values()).toBe("123");
    });

    it("fills every box from a pasted 6-digit code and submits it once", () => {
        const onComplete = vi.fn();
        render(h(Harness, {onComplete}));

        paste(boxes()[0], " 123 456\n");
        expect(values()).toBe("123456");
        expect(focused()).toBe(5);
        expect(onComplete).toHaveBeenCalledTimes(1);
        expect(onComplete).toHaveBeenCalledWith("123456");

        // Pasting the same code again doesn't submit it again.
        paste(boxes()[3], "123456");
        expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("inserts a partial paste at the cursor", () => {
        render(h(Harness));
        type("1");
        paste(boxes()[1], "23");
        expect(values()).toBe("123");
        expect(focused()).toBe(3);
        paste(boxes()[3], "abc");
        expect(values()).toBe("123");
    });

    it("accepts a whole code autofilled into the first box (iOS one-time-code)", () => {
        const onComplete = vi.fn();
        render(h(Harness, {onComplete}));

        fireEvent.change(boxes()[0], {target: {value: "654321"}});
        expect(values()).toBe("654321");
        expect(onComplete).toHaveBeenCalledTimes(1);
        expect(onComplete).toHaveBeenCalledWith("654321");
    });

    it("accepts an autofilled code that keeps the digit already typed", () => {
        const onComplete = vi.fn();
        render(h(Harness, {onComplete}));
        type("6");

        boxes()[0].setSelectionRange(1, 1);
        fireEvent.change(boxes()[0], {target: {value: "6654321"}});
        expect(values()).toBe("654321");
        expect(onComplete).toHaveBeenCalledWith("654321");
    });

    it("ignores non-digits", () => {
        render(h(Harness));
        type("a");
        expect(values()).toBe("");
        expect(focused()).toBe(0);

        type("1-2 3");
        expect(values()).toBe("123");
        expect(focused()).toBe(3);

        // A letter over a selected digit keeps the digit.
        boxes()[0].focus();
        type("x");
        expect(values()).toBe("123");
    });

    it("submits exactly once per complete code, with the complete code", () => {
        const onComplete = vi.fn();
        render(h(Harness, {onComplete}));

        type("123456");
        expect(onComplete).toHaveBeenCalledTimes(1);

        // The same digit typed over the last one: still the same code.
        boxes()[5].focus();
        type("6");
        expect(onComplete).toHaveBeenCalledTimes(1);

        // A corrected code is a new code.
        boxes()[5].focus();
        type("7");
        expect(onComplete).toHaveBeenCalledTimes(2);
        expect(onComplete).toHaveBeenLastCalledWith("123457");

        // After the parent clears the code (wrong code), the same code can be entered again.
        act(() => resetHarness());
        expect(values()).toBe("");
        boxes()[0].focus();
        type("123457");
        expect(onComplete).toHaveBeenCalledTimes(3);
        expect(onComplete).toHaveBeenLastCalledWith("123457");
    });

    it("keeps the mobile and accessibility attributes", () => {
        render(h(Harness));
        expect(screen.getByRole("group", {name: "Authentication code"})).toBeTruthy();
        boxes().forEach((box, i) => {
            expect(box.getAttribute("inputmode")).toBe("numeric");
            expect(box.getAttribute("pattern")).toBe("[0-9]*");
            expect(box.getAttribute("autocomplete")).toBe(i === 0 ? "one-time-code" : "off");
            expect(box.getAttribute("aria-label")).toBe(`Digit ${i + 1} of 6`);
            expect(box.hasAttribute("maxlength")).toBe(false); // autofill puts the whole code into one box
        });
    });

    it("puts the cursor back into the first empty box when re-enabled", () => {
        const {rerender} = render(h(Harness, {disabled: false}));
        type("12");
        rerender(h(Harness, {disabled: true}));
        screen.getByRole("button", {name: "elsewhere"}).focus();
        expect(focused()).toBe(-1);

        rerender(h(Harness, {disabled: false}));
        expect(focused()).toBe(2);
    });
});

// ---------------------------------------------------------------- forms ---

const envelope = (data: unknown, status = 200) =>
    new Response(JSON.stringify({status: status < 400 ? "success" : "error", message: "", data}), {status, headers: {"Content-Type": "application/json"}});

/** fetch mock: CSRF token, and `verify` answers for the verify endpoint (held until released). */
function mockVerify(path: string, answer: () => unknown) {
    const bodies: unknown[] = [];
    let release!: () => void;
    const held = new Promise<void>(resolve => {
        release = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input);
        if (url === "/api/auth/csrf") return envelope({token: "t"});
        if (url === path) {
            bodies.push(JSON.parse(String(init.body)));
            await held;
            return envelope(answer());
        }
        return envelope(undefined, 404);
    }));
    return {bodies, release};
}

const userContext: UserContextType = {
    user: null,
    setUser: () => undefined,
    loading: false,
    authStage: UserAuthState.OTP,
    setAuthStage: () => undefined,
    logout: async () => undefined,
};

const withUser = (child: ReturnType<typeof h>) => h(UserContext.Provider, {value: userContext}, child);

describe("TOTP forms", () => {
    beforeEach(() => {
        clearCsrfToken();
    });

    it("TOTPLoginForm auto-submits the typed code once, also when Enter follows", async () => {
        const authenticated = {user: {id: 1, username: "alice", roles: []}, authState: UserAuthState.AUTHENTICATED};
        const api = mockVerify("/api/auth/login/verify", () => authenticated);
        const onSuccess = vi.fn();
        render(withUser(h(TOTPLoginForm, {onSuccess})));

        type("123456");
        // Enter and a click while the first request is in flight.
        fireEvent.submit(screen.getByRole("button").closest("form")!);
        fireEvent.click(screen.getByRole("button"));

        await waitFor(() => expect(api.bodies).toHaveLength(1));
        expect(boxes().every(box => box.disabled)).toBe(true);
        api.release();
        await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(authenticated));
        expect(api.bodies).toEqual([{token: "123456"}]);
    });

    it("TOTPLoginForm clears a wrong code and lets the user type the next one", async () => {
        let answers = 0;
        const api = mockVerify("/api/auth/login/verify", () => ++answers === 1
            ? {user: null, authState: UserAuthState.OTP}
            : {user: {id: 1, username: "alice", roles: []}, authState: UserAuthState.AUTHENTICATED});
        api.release();
        const onSuccess = vi.fn();
        render(withUser(h(TOTPLoginForm, {onSuccess})));

        type("111111");
        await screen.findByRole("alert");
        expect(screen.getByRole("alert").textContent).toBe("Invalid code. Please try again.");
        await waitFor(() => expect(focused()).toBe(0));
        expect(values()).toBe("");

        type("222222");
        await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
        expect(api.bodies).toEqual([{token: "111111"}, {token: "222222"}]);
    });

    it("TOTPSetupForm auto-submits a pasted code once", async () => {
        const authenticated = {user: {id: 1, username: "owner", roles: ["owner"]}, authState: UserAuthState.AUTHENTICATED};
        const api = mockVerify("/api/auth/setup/verify", () => authenticated);
        const onSuccess = vi.fn();
        render(withUser(h(TOTPSetupForm, {qrCode: "data:image/png;base64,", manualKey: "KEY", onSuccess})));

        paste(boxes()[0], "654321");
        fireEvent.submit(screen.getByRole("button", {name: /^Verif/}).closest("form")!);

        api.release();
        await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(authenticated));
        expect(api.bodies).toEqual([{token: "654321"}]);
    });
});
