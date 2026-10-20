// Picking images for a ticket: from the camera or the photo library on a phone, or pasted as a
// screenshot. Shared by the new-ticket form, the ticket page and the chat composer. It's a controller,
// not an element, so its input and thumbnails live in the host's own shadow root and form.
import { css, html, type ReactiveController, type ReactiveControllerHost } from "lit";
import { imageRules } from "../api.ts";

/** A picked image and its preview URL, revoked when it's removed. */
export interface Picked {
  file: File;
  url: string;
}

/**
 * An iPhone photo that wasn't turned into JPEG on the way: Safari should send a photo picked from the
 * photo library as JPEG, but a HEIC picked from Files can come as it is, even with no type (#14).
 */
const isHeic = (f: File) => /^image\/hei[cf]/.test(f.type) || (!f.type && /\.hei[cf]$/i.test(f.name));
const preview = (f: File) => (typeof URL.createObjectURL === "function" ? URL.createObjectURL(f) : "");
export const forget = (p: Picked) => {
  if (p.url && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(p.url);
};

type Host = ReactiveControllerHost & HTMLElement & { renderRoot: HTMLElement | DocumentFragment };

export class ImagePicker implements ReactiveController {
  images: Picked[] = [];
  /** Why the last images picked weren't all added. */
  problem: string | null = null;

  constructor(
    private readonly host: Host,
    private readonly o: {
      /** Tells this picker's input apart from any other on the page. */
      id: string;
      /** How many images may be picked now; the rules' count when absent. */
      room?: () => number;
      /** What to say when there's no more room. */
      full?: (room: number) => string;
    },
  ) {
    host.addController(this);
  }

  hostDisconnected(): void {
    this.clear();
  }

  get files(): File[] {
    return this.images.map((p) => p.file);
  }

  get room(): number {
    return Math.max(0, Math.min(imageRules.count, this.o.room?.() ?? imageRules.count));
  }

  /** Adds what fits the rules, and says why anything else was left out. */
  add(files: File[]): void {
    const problems: string[] = [];
    const next = [...this.images];
    for (const f of files) {
      const label = f.name || "The pasted image";
      if (isHeic(f))
        problems.push(
          `${label} is a HEIC photo, which a ticket can't take. Pick it from Photo Library, which sends it as JPEG, or set Settings > Camera > Formats to Most Compatible.`,
        );
      else if (!imageRules.types.includes(f.type)) problems.push(`${label} isn't a PNG, JPEG, WebP or GIF.`);
      else if (f.size > imageRules.bytes) problems.push(`${label} is over 10 MB.`);
      else if (next.length >= this.room)
        problems.push(this.o.full?.(this.room) ?? `A ticket takes at most ${this.room} images.`);
      else next.push({ file: f, url: preview(f) });
    }
    this.images = next;
    this.problem = problems.length ? [...new Set(problems)].join(" ") : null;
    this.host.requestUpdate();
  }

  remove(p: Picked): void {
    forget(p);
    this.images = this.images.filter((x) => x !== p);
    this.host.requestUpdate();
  }

  clear(): void {
    this.images.forEach(forget);
    this.images = [];
    this.problem = null;
    this.host.requestUpdate();
  }

  /** For a form's paste event: takes pasted images, and lets text paste as usual. */
  paste = (e: ClipboardEvent): void => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    // A pasted screenshot is often called image.png: number them so each has its own name.
    this.add(
      files.map((f, i) =>
        f.name && f.name !== "image.png"
          ? f
          : new File([f], `screenshot-${this.images.length + i + 1}.${f.type.split("/")[1] ?? "png"}`, {
              type: f.type,
            }),
      ),
    );
  };

  /** Hands the picked images to the caller, who now owns their preview URLs, and empties the picker. */
  take(): Picked[] {
    const taken = this.images;
    this.images = [];
    this.problem = null;
    this.host.requestUpdate();
    return taken;
  }

  /** Opens the file dialog (the camera or photo library on a phone). */
  open(): void {
    this.host.renderRoot.querySelector<HTMLInputElement>(`#${this.o.id}-input`)?.click();
  }

  /** The hidden file input; `open()` clicks it. */
  input() {
    return html`<input id="${this.o.id}-input" type="file" name="images" accept=${imageRules.types.join(",")} multiple hidden
      @change=${(e: Event) => {
        const input = e.target as HTMLInputElement;
        this.add([...(input.files ?? [])]);
        input.value = ""; // so picking the same file again still fires
      }} />`;
  }

  /**
   * The picked images, each with a way to remove it. Compact (for the chat composer) puts a small
   * remove button beside each image, so the strip doesn't crowd out the conversation on a phone.
   */
  thumbs(o: { compact?: boolean } = {}) {
    return this.images.length
      ? html`<ul class="thumbs ${o.compact ? "compact" : ""}">
          ${this.images.map(
            (p) => html`<li>
              <img src=${p.url} alt=${p.file.name} />
              <button type="button" class=${o.compact ? "remove" : "btn ghost"} aria-label="Remove ${p.file.name}"
                @click=${() => this.remove(p)}>${
                  o.compact
                    ? html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>`
                    : "Remove"
                }</button>
            </li>`,
          )}
        </ul>`
      : "";
  }

  /** The label, the hint, the thumbnails and the button; the host shows `problem` where it fits. */
  render(o: { label: string; hint: string }) {
    const { id } = this.o;
    const full = this.images.length >= this.room;
    return html`<div class="images" role="group" aria-labelledby="${id}-label">
      <span id="${id}-label">${o.label}</span>
      <span class="hint">${o.hint}</span>
      ${this.input()}
      ${this.thumbs()}
      <button type="button" class="btn ghost pick" ?disabled=${full} @click=${() => this.open()}>
        ${full ? (this.images.length ? `${this.images.length} images added` : "No room for more images") : this.images.length ? "Add more images" : "Add images"}
      </button>
    </div>`;
  }
}

export const imagePickerStyles = css`
  .images { display: flex; flex-direction: column; gap: 8px; font-size: 13px; font-weight: 700; color: var(--ink-2); }
  .images .hint { font-weight: 400; }
  .pick { align-self: flex-start; }
  .thumbs { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 10px; }
  .thumbs li { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .thumbs img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); }
  .thumbs .btn { min-height: 44px; width: 100%; }
  .thumbs.compact { display: flex; flex-wrap: wrap; gap: 8px 14px; }
  .thumbs.compact li { flex-direction: row; align-items: center; gap: 2px; }
  .thumbs.compact img { width: 64px; height: 64px; }
  .thumbs .remove { flex: none; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 50%; background: none;
    display: grid; place-items: center; cursor: pointer; color: var(--ink-2); }
  .thumbs .remove:hover { background: var(--sunken); color: var(--ink); }
  .thumbs .remove:focus-visible { outline: 2px solid var(--ink); outline-offset: -2px; }
  .thumbs .remove svg { width: 20px; height: 20px; }
`;
