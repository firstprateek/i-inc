// The sign-in form, shown when the daemon answers 401: the owner pastes the login token once, from
// ~/.config/i-inc/web-token on the mini, and the daemon keeps it as an HttpOnly cookie for 30 days.
let shown = false;

export function showLogin(): void {
  if (shown) return;
  shown = true;
  document.body.innerHTML = `
    <form id="login" style="width:calc(100% - 32px);max-width:24rem;margin:15vh auto;padding:1.5rem;box-sizing:border-box;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);font:15px/1.5 var(--body);color:var(--ink)">
      <h1 style="font:700 22px/1.2 var(--display);letter-spacing:-0.3px;margin:0 0 .5rem">Sign in to i.inc</h1>
      <p style="margin:0 0 1rem;color:var(--ink-2)">Paste the token from <code style="font-family:var(--mono)">~/.config/i-inc/web-token</code> on the mini.</p>
      <input name="token" type="password" autocomplete="current-password" aria-label="Login token"
        style="width:100%;min-height:44px;box-sizing:border-box;padding:0 12px;margin:0 0 12px;border:1px solid var(--line-strong);border-radius:12px;font:inherit;background:var(--surface);color:var(--ink)" />
      <p id="login-error" role="alert" hidden style="color:var(--alarm-fg);margin:0 0 12px"></p>
      <button style="min-height:44px;padding:0 18px;border:0;border-radius:999px;background:var(--ink);color:var(--on-ink);font:700 15px var(--body);cursor:pointer;white-space:nowrap">Sign in</button>
    </form>`;
  const form = document.getElementById("login") as HTMLFormElement;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const token = String(new FormData(form).get("token") ?? "").trim();
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (res.ok) location.reload();
    else {
      const err = document.getElementById("login-error") as HTMLElement;
      err.hidden = false;
      err.textContent = "That's not the token.";
    }
  });
}
