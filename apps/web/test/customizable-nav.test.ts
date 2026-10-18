import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CATEGORIES,
  DEFAULT_PINNED_VIEWS,
  IncApp,
  readPinnedViews,
  STORAGE_KEY_PINNED,
  savePinnedViews,
  VIEW_CATALOG,
} from "../src/components/app.ts";

async function mountApp(hash = "#/office"): Promise<{ app: IncApp; root: ShadowRoot }> {
  location.hash = hash;
  const app = new IncApp();
  document.body.appendChild(app);
  await app.updateComplete;
  return { app, root: app.shadowRoot as ShadowRoot };
}

describe("Customizable top navigation bar & All views dropdown", () => {
  beforeEach(() => {
    localStorage.clear();
    location.hash = "#/office";
  });

  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    location.hash = "";
  });

  it("exports a complete, categorized VIEW_CATALOG with valid routes", () => {
    expect(VIEW_CATALOG.length).toBe(9);
    for (const cat of CATEGORIES) {
      const items = VIEW_CATALOG.filter((v) => v.category === cat);
      expect(items.length).toBeGreaterThan(0);
    }
    const ids = VIEW_CATALOG.map((v) => v.id);
    expect(ids).toContain("inbox");
    expect(ids).toContain("office");
    expect(ids).toContain("board");
    expect(ids).toContain("chat");
    expect(ids).toContain("desk");
    expect(ids).toContain("handbook");
    expect(ids).toContain("hiring");
    expect(ids).toContain("setup");
    expect(ids).toContain("notifications");
  });

  it("renders default pinned views in top navigation bar in default order", async () => {
    const { root } = await mountApp("#/office");
    const navLinks = [...(root.querySelectorAll("header nav a") as NodeListOf<HTMLAnchorElement>)];
    const hrefs = navLinks.map((a) => a.getAttribute("href"));

    expect(hrefs).toEqual([
      "#/office",
      "#/board",
      "#/chat",
      "#/desk",
      "#/handbook",
      "#/hiring",
      "#/setup/teams",
      "#/inbox",
    ]);

    // Active link has aria-current="page"
    const activeLink = navLinks.find((a) => a.getAttribute("aria-current") === "page");
    expect(activeLink?.getAttribute("href")).toBe("#/office");

    // All views trigger button is rendered
    const trigger = root.querySelector<HTMLButtonElement>(".all-views-trigger");
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute("aria-haspopup")).toBe("true");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(trigger?.textContent).toContain("All views");

    // Dropdown is not rendered initially
    expect(root.querySelector(".all-views-dropdown")).toBeNull();
  });

  it("toggles the All views dropdown open and closed on trigger click", async () => {
    const { app, root } = await mountApp("#/office");
    const trigger = root.querySelector<HTMLButtonElement>(".all-views-trigger");
    if (!trigger) throw new Error("Missing trigger");

    // Open dropdown
    trigger.click();
    await app.updateComplete;

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const dropdown = root.querySelector(".all-views-dropdown");
    expect(dropdown).not.toBeNull();
    expect(dropdown?.textContent).toContain("All views");

    // Close dropdown
    trigger.click();
    await app.updateComplete;

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector(".all-views-dropdown")).toBeNull();
  });

  it("closes the dropdown when clicking the close button", async () => {
    const { app, root } = await mountApp("#/office");
    const trigger = root.querySelector<HTMLButtonElement>(".all-views-trigger");
    if (!trigger) throw new Error("Missing trigger");

    trigger.click();
    await app.updateComplete;

    const closeBtn = root.querySelector<HTMLButtonElement>(".close-btn");
    if (!closeBtn) throw new Error("Missing close button");
    closeBtn.click();
    await app.updateComplete;

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector(".all-views-dropdown")).toBeNull();
  });

  it("closes the dropdown on Escape key and focuses trigger", async () => {
    const { app, root } = await mountApp("#/office");
    const trigger = root.querySelector<HTMLButtonElement>(".all-views-trigger");
    if (!trigger) throw new Error("Missing trigger");

    trigger.click();
    await app.updateComplete;
    expect(root.querySelector(".all-views-dropdown")).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await app.updateComplete;

    expect(root.querySelector(".all-views-dropdown")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders all categories and views inside the dropdown with current indicator", async () => {
    const { app, root } = await mountApp("#/office");
    const trigger = root.querySelector<HTMLButtonElement>(".all-views-trigger");
    if (!trigger) throw new Error("Missing trigger");

    trigger.click();
    await app.updateComplete;

    const headings = [...root.querySelectorAll(".category-heading")].map((h) => h.textContent?.trim());
    expect(headings).toEqual(["Workspace", "Operations & Knowledge", "Management"]);

    const viewRows = [...root.querySelectorAll(".view-row")];
    expect(viewRows.length).toBe(9);

    // Active view (office) has .is-active and .active-pill
    const officeRow = viewRows.find(
      (row) => row.querySelector(".view-label")?.textContent?.trim() === "Office",
    );
    expect(officeRow).toBeDefined();
    expect(officeRow?.classList.contains("is-active")).toBe(true);
    expect(officeRow?.querySelector(".active-pill")?.textContent?.trim()).toBe("Current");
  });

  it("pins and unpins views, updating top navigation bar and localStorage immediately", async () => {
    const { app, root } = await mountApp("#/office");
    const trigger = root.querySelector<HTMLButtonElement>(".all-views-trigger");
    if (!trigger) throw new Error("Missing trigger");

    trigger.click();
    await app.updateComplete;

    // Notifications is unpinned by default
    const notifRow = [...root.querySelectorAll(".view-row")].find(
      (row) => row.querySelector(".view-label")?.textContent?.trim() === "Notifications",
    );
    if (!notifRow) throw new Error("Missing notifications row");
    expect(notifRow.classList.contains("is-pinned")).toBe(false);
    const pinBtn = notifRow.querySelector<HTMLButtonElement>(".pin-btn");
    if (!pinBtn) throw new Error("Missing pin button");
    expect(pinBtn.getAttribute("aria-pressed")).toBe("false");
    expect(pinBtn.textContent).toContain("Pin");

    // Pin Notifications
    pinBtn.click();
    await app.updateComplete;

    // Check localStorage
    const savedPinned = JSON.parse(localStorage.getItem(STORAGE_KEY_PINNED) ?? "[]");
    expect(savedPinned).toContain("notifications");

    // Top nav bar now includes #/setup/notifications
    const navHrefs = [...root.querySelectorAll(".pinned-links a")].map((a) => a.getAttribute("href"));
    expect(navHrefs).toContain("#/setup/notifications");

    // Now unpin desk
    const deskRow = [...root.querySelectorAll(".view-row")].find(
      (row) => row.querySelector(".view-label")?.textContent?.trim() === "My desk",
    );
    if (!deskRow) throw new Error("Missing desk row");
    expect(deskRow.classList.contains("is-pinned")).toBe(true);
    const deskPinBtn = deskRow.querySelector<HTMLButtonElement>(".pin-btn");
    if (!deskPinBtn) throw new Error("Missing desk pin button");
    expect(deskPinBtn.getAttribute("aria-pressed")).toBe("true");

    deskPinBtn.click();
    await app.updateComplete;

    const navHrefsAfterUnpin = [...root.querySelectorAll(".pinned-links a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(navHrefsAfterUnpin).not.toContain("#/desk");
  });

  it("guards against unpinning when only one view is pinned", async () => {
    // Seed with only 1 pinned view
    savePinnedViews(["office"]);
    const { app, root } = await mountApp("#/office");
    const trigger = root.querySelector<HTMLButtonElement>(".all-views-trigger");
    if (!trigger) throw new Error("Missing trigger");

    trigger.click();
    await app.updateComplete;

    const officeRow = [...root.querySelectorAll(".view-row")].find(
      (row) => row.querySelector(".view-label")?.textContent?.trim() === "Office",
    );
    if (!officeRow) throw new Error("Missing office row");
    const officePinBtn = officeRow.querySelector<HTMLButtonElement>(".pin-btn");
    if (!officePinBtn) throw new Error("Missing office pin button");
    expect(officePinBtn.disabled).toBe(true);
    expect(officePinBtn.getAttribute("title")).toBe("At least one view must remain pinned");

    // Clicking disabled button doesn't unpin
    officePinBtn.click();
    await app.updateComplete;

    expect(readPinnedViews()).toEqual(["office"]);
  });

  it("re-arranges view order using move up and move down buttons", async () => {
    const { app, root } = await mountApp("#/office");
    const trigger = root.querySelector<HTMLButtonElement>(".all-views-trigger");
    if (!trigger) throw new Error("Missing trigger");

    trigger.click();
    await app.updateComplete;

    // Default order: office (#1), board (#2), chat (#3), ...
    const officeRow = [...root.querySelectorAll(".view-row")].find(
      (row) => row.querySelector(".view-label")?.textContent?.trim() === "Office",
    );
    if (!officeRow) throw new Error("Missing office row");
    const moveDownOffice = officeRow.querySelector<HTMLButtonElement>(".move-down");
    const moveUpOffice = officeRow.querySelector<HTMLButtonElement>(".move-up");
    if (!moveDownOffice || !moveUpOffice) throw new Error("Missing office move buttons");

    // Office is first (#1), so move up is disabled
    expect(moveUpOffice.disabled).toBe(true);
    expect(moveDownOffice.disabled).toBe(false);

    // Move office down (swap with board)
    moveDownOffice.click();
    await app.updateComplete;

    // Verify new order in localStorage and top nav
    const updatedPinned = readPinnedViews();
    expect(updatedPinned[0]).toBe("board");
    expect(updatedPinned[1]).toBe("office");

    const navHrefs = [...root.querySelectorAll(".pinned-links a")].map((a) => a.getAttribute("href"));
    expect(navHrefs[0]).toBe("#/board");
    expect(navHrefs[1]).toBe("#/office");

    // Move board down (swap back)
    const boardRow = [...root.querySelectorAll(".view-row")].find(
      (row) => row.querySelector(".view-label")?.textContent?.trim() === "Board",
    );
    if (!boardRow) throw new Error("Missing board row");
    const moveDownBoard = boardRow.querySelector<HTMLButtonElement>(".move-down");
    if (!moveDownBoard) throw new Error("Missing board move down button");
    moveDownBoard.click();
    await app.updateComplete;

    const restoredPinned = readPinnedViews();
    expect(restoredPinned[0]).toBe("office");
    expect(restoredPinned[1]).toBe("board");
  });

  it("resets to default pinned views and order when clicking Reset", async () => {
    // Seed customized order
    savePinnedViews(["chat", "inbox"]);
    const { app, root } = await mountApp("#/office");
    const trigger = root.querySelector<HTMLButtonElement>(".all-views-trigger");
    if (!trigger) throw new Error("Missing trigger");

    let navHrefs = [...root.querySelectorAll(".pinned-links a")].map((a) => a.getAttribute("href"));
    expect(navHrefs).toEqual(["#/chat", "#/inbox"]);

    trigger.click();
    await app.updateComplete;

    const resetBtn = root.querySelector<HTMLButtonElement>(".reset-btn");
    if (!resetBtn) throw new Error("Missing reset button");
    resetBtn.click();
    await app.updateComplete;

    // Restores default
    expect(readPinnedViews()).toEqual(DEFAULT_PINNED_VIEWS);
    navHrefs = [...root.querySelectorAll(".pinned-links a")].map((a) => a.getAttribute("href"));
    expect(navHrefs).toEqual([
      "#/office",
      "#/board",
      "#/chat",
      "#/desk",
      "#/handbook",
      "#/hiring",
      "#/setup/teams",
      "#/inbox",
    ]);
  });

  it("navigates to selected view and closes dropdown when clicking a view link", async () => {
    const { app, root } = await mountApp("#/office");
    const trigger = root.querySelector<HTMLButtonElement>(".all-views-trigger");
    if (!trigger) throw new Error("Missing trigger");

    trigger.click();
    await app.updateComplete;

    const deskRow = [...root.querySelectorAll(".view-row")].find(
      (row) => row.querySelector(".view-label")?.textContent?.trim() === "My desk",
    );
    if (!deskRow) throw new Error("Missing desk row");
    const deskLink = deskRow.querySelector<HTMLAnchorElement>(".view-link");
    if (!deskLink) throw new Error("Missing desk link");

    deskLink.click();
    await app.updateComplete;

    expect(location.hash).toBe("#/desk");
    expect(root.querySelector(".all-views-dropdown")).toBeNull();
  });

  it("keeps the dropdown header fixed at top while categories list scrolls", async () => {
    const { app, root } = await mountApp("#/office");
    const trigger = root.querySelector<HTMLButtonElement>(".all-views-trigger");
    if (!trigger) throw new Error("Missing trigger");

    trigger.click();
    await app.updateComplete;

    const dropdown = root.querySelector<HTMLElement>(".all-views-dropdown");
    expect(dropdown).not.toBeNull();
    const header = dropdown?.querySelector<HTMLElement>(".dropdown-header");
    expect(header).not.toBeNull();
    expect(header?.querySelector(".dropdown-title")?.textContent).toBe("All views");
    expect(header?.querySelector(".close-btn")).not.toBeNull();

    const categoriesList = dropdown?.querySelector<HTMLElement>(".categories-list");
    expect(categoriesList).not.toBeNull();

    // The header is outside the scroll container (.categories-list) so it remains fixed
    if (header) {
      expect(dropdown?.contains(header)).toBe(true);
      expect(categoriesList?.contains(header)).toBe(false);
    }
  });
});
