# npm Installation Failure Analysis

## Issue Summary

The `install-and-run.bat` script fails during dependency installation with error code `EALLOWREMOTE`, preventing users from setting up the project.

## Error Details

```
npm error code EALLOWREMOTE
npm error Fetching packages of type "remote" have been disabled
npm error Refusing to fetch "util-deprecate@https://registry.npmmirror.com/util-deprecate/-/util-deprecate-1.0.2.tgz"
```

## Root Cause

**npm 12 Security Policy Change**: Starting with npm 12, the `allow-remote` configuration defaults to `none`, blocking tarball installations from non-standard registries.

The project's `package-lock.json` contains resolved URLs pointing to `registry.npmmirror.com` (Chinese npm mirror) instead of the official `registry.npmjs.org`. When npm 12 attempts to install these dependencies, it treats them as "remote" packages and blocks the installation per the new security policy.

### Technical Details

From npm CLI source code:
- `allow-remote` default changed from implicit `all` to explicit `none` in npm 12
- Tarballs that don't share a hostname with the configured registry are blocked
- Error code `EALLOWREMOTE` is thrown by the Arborist build-ideal-tree module

## Solution

Regenerate `package-lock.json` using the official npm registry to ensure all resolved URLs point to `registry.npmjs.org`.

### Steps Applied

1. Delete the existing `package-lock.json` containing mirror URLs
2. Run `npm install` to regenerate the lockfile from the official registry
3. Verify the new lockfile contains only `registry.npmjs.org` resolved URLs

## Prevention

To prevent this issue in the future:

1. **Ensure consistent registry configuration** across all development environments
2. **Document registry requirements** in project README
3. **Add CI check** to verify lockfile resolved URLs match the official registry
4. **Consider `.npmrc`** with explicit registry configuration in the project root

## References

- npm CLI `allow-remote` configuration: [npm/cli definitions.js](https://github.com/npm/cli/blob/latest/workspaces/config/lib/definitions/definitions.js)
- npm 12 security changes: Default changed from implicit `all` to explicit `none`
- Arborist enforcement: [build-ideal-tree.js](https://github.com/npm/cli/blob/latest/workspaces/arborist/lib/arborist/build-ideal-tree.js)

## Impact

- **Severity**: High - Blocks new contributors from setting up the project
- **Affected versions**: npm 12.x and later
- **Scope**: All fresh installations using the affected lockfile
