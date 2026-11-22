/**
 * Deployment configuration.
 *
 * `clientId` is the public client id of the pydle GitHub OAuth App. It is not a
 * secret. The App must have "Enable Device Flow" ticked or every request comes back
 * with `device_flow_disabled`.
 */
export const CONFIG = {
    clientId: 'Ov23ligramyjE9ZbukBl',
    // TODO: switch to https://auth.pydle.uk once the zone stops blocking the
    // worker hostname (see docs/PLAN.md). The custom domain is attached and
    // working, but the zone's bot protection answers 403 to every method.
    shimBase: 'https://pydle-auth.thebillington.workers.dev',
    apiBase: 'https://api.github.com',
    apiVersion: '2026-03-10',
    scopes: ['repo'],
};
