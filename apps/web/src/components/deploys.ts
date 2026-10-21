// The deployer's recent deploys (contract C21, GET /api/deploys). Self-contained, so it can sit in
// whichever view shows releases: <inc-deploys></inc-deploys>.
import { css, html } from "lit";
import { call } from "../api.ts";
import { Loader } from "./loader.ts";
import { base } from "./shared.ts";

interface Deploy {
  at: number;
  sha: string;
  from: string | null;
  outcome: "deployed" | "rolled-back" | "failed-build" | "failed-smoke" | "skipped-ci" | "skipped-ancestry";
  reason: string;
  durationMs: number;
}

const names: Record<Deploy["outcome"], string> = {
  deployed: "Deployed",
  "rolled-back": "Rolled back",
  "failed-build": "Build failed",
  "failed-smoke": "Smoke test failed",
  "skipped-ci": "Skipped: CI failed",
  "skipped-ancestry": "Skipped: history rewritten",
};

const when = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");
const took = (ms: number) =>
  ms < 1000 ? "" : ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;

const HAND = /^rolled back by hand to [0-9a-f]{7}$/;

/**
 * What a row says, so a rollback is never ambiguous about which sha is which. A rollback by hand has
 * `sha` = the release now running and `from` = the one left; an automatic one has `sha` = the rejected
 * commit and `from` = the release kept. Records from before that change have `from` = `sha`: no arrow.
 */
function describeRow(x: Deploy): { label: string; shas: string; reason: string } {
  const sha = x.sha.slice(0, 7);
  const from = x.from?.slice(0, 7);
  const arrow = x.outcome === "rolled-back" && from && from !== sha;
  if (arrow && x.reason.startsWith("rolled back by hand")) {
    return {
      label: "Rolled back by hand",
      shas: `${from} → ${sha}`,
      reason: HAND.test(x.reason) ? "" : x.reason.replace(/^rolled back by hand to [0-9a-f]{7},?\s*/, ""),
    };
  }
  if (arrow) return { label: "Rolled back", shas: `${sha} → kept ${from}`, reason: x.reason };
  return { label: names[x.outcome] ?? x.outcome, shas: sha, reason: x.reason };
}

export class IncDeploys extends Loader<Deploy[]> {
  // An older daemon has no /api/deploys: show an empty list rather than an error.
  protected fetch = () =>
    call<{ deploys: Deploy[] }>("GET", "/api/deploys")
      .then((r) => r.deploys)
      .catch(() => [] as Deploy[]);

  static override styles = [
    base,
    css`
      :host { display: block; }
      h3 { margin: 12px 0 6px; }
      .deploys { display: flex; flex-direction: column; gap: 4px; }
      .deploy { display: flex; flex-direction: column; gap: 2px; padding: 6px 0; border-top: 1px solid var(--line); font-size: 13px; }
      .deploy:first-child { border-top: none; }
      .head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .outcome { font-weight: 700; }
      .deploy.bad .outcome { color: var(--alarm); }
      .reason { color: var(--ink-2); overflow-wrap: anywhere; }
      .spacer { flex-grow: 1; }
      .mono { font-family: var(--mono); }
      .note { font-size: 13px; color: var(--ink-2); }
    `,
  ];

  override render() {
    const list = this.data ?? [];
    return html`<h3>Deploys</h3>
      ${
        list.length
          ? html`<div class="deploys">${list.slice(0, 8).map((x) => {
              const row = describeRow(x);
              return html`<div class="deploy ${x.outcome === "deployed" ? "" : "bad"}">
                <div class="head">
                  <span class="outcome">${row.label}</span>
                  <span class="mono">${row.shas}</span>
                  <span class="spacer"></span>
                  <small class="muted">${when(x.at)}${took(x.durationMs) ? ` · ${took(x.durationMs)}` : ""}</small>
                </div>
                ${row.reason ? html`<span class="reason">${row.reason}</span>` : ""}
              </div>`;
            })}</div>`
          : html`<span class="note">No deploys yet. New commits with green CI go live by themselves once the deployer is installed.</span>`
      }`;
  }
}

customElements.define("inc-deploys", IncDeploys);
