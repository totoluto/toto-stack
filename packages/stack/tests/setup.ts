import {afterEach, vi} from "vitest";

// Per-test isolation for process-wide test state (see vitest.config.ts):
// advanceClock() and tests that fake timers get real time back after each test.
afterEach(() => {
    vi.useRealTimers();
});
