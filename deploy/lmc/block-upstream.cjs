// Acceptance guard: reject former hosted dependencies without changing system DNS.
const dns = require('node:dns');
const denied = ['cluster-fluster.com', 'happy.engineering', 'happy-servers.com', 'elevenlabs.io', 'expo.dev', 'exp.host', 'posthog.com', 'revenuecat.com'];
function check(host) {
  host = String(host).toLowerCase().replace(/\.$/, '');
  if (denied.some(domain => host === domain || host.endsWith('.' + domain))) {
    const error = new Error('LMC upstream blocked: ' + host); error.code = 'ENOTFOUND'; throw error;
  }
}
const lookup = dns.lookup;
dns.lookup = function(host, ...args) { try { check(host); } catch(error) { const cb = args.at(-1); if(typeof cb==='function') return queueMicrotask(()=>cb(error)); throw error; } return lookup.call(this,host,...args); };
const promiseLookup = dns.promises.lookup;
dns.promises.lookup = async function(host, ...args) { check(host); return promiseLookup.call(this,host,...args); };
module.exports = { check };
