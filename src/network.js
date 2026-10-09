import { EnvHttpProxyAgent } from 'undici';

let proxyAgent;

// Honor managed/corporate proxies without relaxing HTTPS certificate checks.
export function getDispatcher(url) {
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return undefined;
  if (!process.env.HTTPS_PROXY && !process.env.https_proxy && !process.env.HTTP_PROXY && !process.env.http_proxy) return undefined;
  proxyAgent ??= new EnvHttpProxyAgent();
  return proxyAgent;
}
