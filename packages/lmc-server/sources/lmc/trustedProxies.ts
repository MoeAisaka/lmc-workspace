/** Only the local TLS proxy is trusted by default. Container deployments must
 * explicitly list their proxy addresses/CIDRs; never trust arbitrary XFF. */
export function trustedProxies(value = process.env.LMC_TRUSTED_PROXIES): string[] {
    return (value ?? '127.0.0.1/32,::1/128').split(',').map(x => x.trim()).filter(Boolean);
}
