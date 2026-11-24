const KIRO_REGION_FROM_ARN_REGEX = /^arn:aws:codewhisperer:([a-z0-9-]+):/i;

export function extractRegionFromKiroProfileArn(profileArn) {
    if (typeof profileArn !== 'string') {
        return null;
    }
    const match = profileArn.trim().match(KIRO_REGION_FROM_ARN_REGEX);
    return match?.[1] || null;
}

export function isKiroBuilderIdAuth(authMethod) {
    const normalized = String(authMethod || '').toLowerCase().replace(/[_\s]/g, '-');
    return normalized === 'builder-id' || normalized === 'builderid';
}

export function isKiroEnterpriseIdpAuth(authMethod, identityProvider = null) {
    const normalizedMethod = String(authMethod || '').toLowerCase().replace(/[_\s]/g, '-');
    const normalizedIdp = String(identityProvider || '').toLowerCase().replace(/[_\s]/g, '-');
    return normalizedMethod === 'external-idp' ||
        normalizedMethod === 'externalidp' ||
        normalizedMethod === 'enterprise' ||
        normalizedMethod === 'idc' ||
        normalizedIdp === 'external-idp' ||
        normalizedIdp === 'externalidp' ||
        normalizedIdp === 'enterprise';
}

/**
 * Resolve the tokentype header value according to decode docs:
 * - API_KEY when using Kiro API key (ksk_... or explicit apiKey)
 * - EXTERNAL_IDP when using Enterprise / External IdP credentials
 */
export function resolveKiroTokenTypeHeader({ accessToken, apiKey, authMethod, identityProvider }) {
    if (typeof accessToken === 'string' && accessToken.trim() !== '') {
        if (accessToken.startsWith('ksk_') || (apiKey && accessToken === apiKey)) {
            return 'API_KEY';
        }
    }
    if (isKiroEnterpriseIdpAuth(authMethod, identityProvider)) {
        return 'EXTERNAL_IDP';
    }
    return undefined;
}

/**
 * AWS Builder ID, Enterprise IdC, and API Key credentials can discover their
 * profile via GetProfile / ListAvailableProfiles when profileArn is not yet set.
 * Try discovery for every profileless, non-social credential; callers treat a
 * failed discovery as a soft failure and retain the profileless fallback.
 */
export function shouldDiscoverKiroProfile({ isSocialAuth, profileArn }) {
    const hasProfileArn = typeof profileArn === 'string' && profileArn.trim() !== '';
    return !hasProfileArn && !isSocialAuth;
}

/**
 * Keep any real profile supplied or discovered for a credential.
 * For a profileless credential, never manufacture or persist a placeholder ARN.
 */
export function resolveKiroRequestProfileArn(authMethod, profileArn) {
    if (typeof profileArn === 'string' && profileArn.trim() !== '') {
        return profileArn;
    }
    if (isKiroBuilderIdAuth(authMethod)) {
        return undefined;
    }
    return undefined;
}

/**
 * The q.* generation endpoint can require profileArn, while the legacy
 * CodeWhisperer endpoint accepts Builder ID without one. Route only profileless
 * Builder ID requests; credentials with a real profile keep the normal route.
 */
export function shouldRouteBuilderToCodeWhisperer({ authMethod, profileArn, requestUrl }) {
    if (!isKiroBuilderIdAuth(authMethod) ||
        (typeof profileArn === 'string' && profileArn.trim() !== '')) {
        return false;
    }

    try {
        const url = new URL(requestUrl);
        const pathname = url.pathname.toLowerCase();
        return /^q\.[a-z0-9-]+\.amazonaws\.com$/i.test(url.hostname) &&
            (pathname === '/' || pathname === '' || pathname === '/generateassistantresponse');
    } catch {
        return false;
    }
}
