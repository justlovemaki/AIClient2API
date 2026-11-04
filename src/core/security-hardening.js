// Compatibility entry point imported by master.js and api-server.js.
// User plugins are administrator-trusted server extensions, not sandboxed code.
// Authentication, explicit approval and package hashes are enforced by the
// plugin API / manager BEFORE import(). Once approved, a plugin has the same
// privileges as this process. Stack inspection, regexes and monkey patches
// cannot constrain adversarial JavaScript and must not be presented as a sandbox.
// Deliberately do not patch global fs/process/network APIs: trusted plugins need
// normal Node.js APIs, and the former patches blocked legitimate operations
// without providing a reliable security boundary.
console.log('[Plugin Security] Trusted-plugin mode: administrator-approved plugins run with server privileges; no JavaScript sandbox is provided.');
