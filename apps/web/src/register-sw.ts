// Registers the service worker (public/sw.js) in production builds, in secure contexts only.

export interface Env {
  production: boolean;
  secure: boolean;
  supported: boolean;
}

export function shouldRegister(env: Env): boolean {
  return env.production && env.secure && env.supported;
}

export function registerServiceWorker(env?: Partial<Env>): boolean {
  const ok = shouldRegister({
    production: env?.production ?? import.meta.env.PROD,
    secure: env?.secure ?? globalThis.isSecureContext === true,
    supported: env?.supported ?? "serviceWorker" in navigator,
  });
  if (!ok) return false;
  const register = () => void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  if (document.readyState === "complete") register();
  else addEventListener("load", register, { once: true });
  return true;
}
