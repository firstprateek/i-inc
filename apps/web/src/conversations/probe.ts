// A test-only probe for the text scanners (markdown, highlight). Unset, which it always is outside the tests,
// each call site is one read of an undefined property: no counting, no allocation. A test sets `probe.work` to
// a function and is told how many characters each search or scan looked at, so it can assert that the total
// grows in step with the text (4x the text, about 4x the count) instead of timing the code, which depends on
// how busy the machine is. A scanner that rescans (square) or backtracks (cube) fails that by a wide margin.
export const probe: { work?: ((chars: number) => void) | undefined } = {};
