// Process-wide latch: every Antigravity adapter and pool alias shares it.
// After reviewing the upstream violation, an operator can restart the worker.
let paused = false;

export function pauseAntigravityPool() {
    if (paused) return false;
    paused = true;
    return true;
}

export function isAntigravityPoolPaused() {
    return paused;
}

export function assertAntigravityPoolActive() {
    if (!paused) return;
    throw Object.assign(new Error('Antigravity pool is paused after an upstream TOS_VIOLATION. Operator review required.'), {
        status: 503,
        skipErrorCount: true,
        stopCredentialRetry: true
    });
}
