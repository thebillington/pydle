/**
 * Deployment configuration.
 *
 * `clientId` is the public client id of the pydle GitHub OAuth App. It is not a
 * secret. The App must have "Enable Device Flow" ticked or every request comes back
 * with `device_flow_disabled`.
 */
export const CONFIG = {
    clientId: 'Ov23ligramyjE9ZbukBl',
    shimBase: 'https://auth.pydle.uk',
    apiBase: 'https://api.github.com',
    apiVersion: '2026-03-10',
    scopes: ['repo'],
};
