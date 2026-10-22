// What a personal assistant is told, and what "done" means for the tickets that teach it (spec §5, §7).
//
// A PA's sandbox has no internet and no root, and its model is a small local one (an 8B model on Ollama,
// reached through the relay). So its briefs are short, name the exact path of every file it should write,
// say what the machine does not have, and show the page format to copy. Pure: the daemon feeds these
// into briefs and turns, and the runner checks them when an orientation or a tidy-up ends.
import { brainRoot } from "./brain-prompt.ts";
import type { Employee, Ticket } from "./model.ts";

/** The two pages a PA's orientation must leave in its own brain (folder/name, as the daemon files them). */
export const homePages = {
  help: "reference/how-i-help-at-home",
  errands: "patterns/errands",
} as const;

/**
 * What the PA's machine has and hasn't. It goes in every brief and every conversation turn of a PA, because
 * a small model that is not told tries `sudo apt install` (Pip did, on 2026-10-22) and gives up when it fails.
 * `root` is where its brain copy is, so the commands can be copied as they are.
 */
export function offlineNotes(employeeId: string): string {
  const root = brainRoot(employeeId);
  return [
    "Your machine (read once, it does not change):",
    "- It has NO internet, no sudo and no root. apt, npm install, pip and curl to the web all fail. Do not try them.",
    "- You have: a shell (bash, ls, cat, head, tail, sed, find, wc, grep, git, node, jq), your file tools (read, write, edit, glob, grep) and the brain command.",
    `- The brain command: ${root}/.bin/brain search "words". Your brain copy is the folder ${root}/ (your own pages are in ${root}/personal/).`,
    '- `rg` (ripgrep) may be missing. If `rg` says not found, use: grep -rn "words" <folder>',
    "- You do NOT have: sudo, apt, docker, gh, python, a browser, any website. Do not install anything.",
    "- Write files only under /home/employee. If a tool fails, say so in one line and use another way. Never run the same failing command twice.",
  ].join("\n");
}

/** What an orientation is done when, for a new hire. A PA has no code projects, so its list is its own. */
export function orientationDoneWhen(isHome: boolean): string[] {
  if (isHome) {
    return [
      `your brain has the page ${homePages.help} (how you help at home, with a "My tools" section)`,
      `your brain has the page ${homePages.errands} (a starter errands page)`,
    ];
  }
  return ["the brain has a page for each project"];
}

const frontmatter = (title: string, description: string) =>
  `---\ntitle: ${title}\ndescription: ${description}\n---`;

/** The example the PA copies for its first page. Short on purpose: an 8B model copies a shape better than it follows rules. */
export function helpPageExample(): string {
  return [
    frontmatter("How I help at home", "What I do for the owner at home, and the rules I keep"),
    "# How I help at home",
    "- I work on Home: mail, calendar, shopping, plans for the week.",
    "- I prepare drafts, summaries, shortlists and answers. I never send, pay, book or delete.",
    "- Whatever I prepare reaches the owner as a proposal. The owner approves it.",
    "- I ask when I don't know something. I don't guess names, dates or amounts.",
    "- My model runs on the host; nothing leaves the house.",
    "## My tools",
    "- shell: works",
    "- git: works",
    "- brain search: works",
    "- internet, sudo, installs: not available",
  ].join("\n");
}

export function errandsPageExample(): string {
  return [
    frontmatter("Errands", "How I run an errand from request to proposals"),
    "# Errands",
    "1. Read the request. Say it back in one line.",
    "2. Find what I need: my brain first, then the home tools.",
    "3. Write each outgoing action as a proposal: a draft reply, an event, a shortlist or an answer.",
    "4. Stop. The owner decides. Nothing goes out by itself.",
    "## Habits",
    "- (none yet: add what I learn about the owner here)",
  ].join("\n");
}

/** The PA's orientation, as the task of its one stage. Short steps, exact paths. */
export function homeOrientationTask(employee: Pick<Employee, "id" | "name">): string {
  const root = brainRoot(employee.id);
  const help = `${root}/personal/${homePages.help}.md`;
  const errands = `${root}/personal/${homePages.errands}.md`;
  return [
    `This is your orientation, ${employee.name}. You have no code projects: you work on the owner's home. Do 4 small jobs, in order, with the files and shell. Do not search the web.`,
    "",
    "Job 1. Look around (at most 4 commands):",
    `  cat ${root}/personal/INDEX.md`,
    `  ls ${root}/company`,
    `  grep -rli "home\\|errand\\|assistant" ${root}/company | head -3   (then cat those files)`,
    "",
    `Job 2. Write the file ${help}`,
    `  First: mkdir -p ${root}/personal/reference`,
    "  Copy this shape and change the words so they are true for you:",
    helpPageExample()
      .split("\n")
      .map((l) => `  | ${l}`)
      .join("\n"),
    "",
    `Job 3. Write the file ${errands}`,
    `  First: mkdir -p ${root}/personal/patterns`,
    "  Copy this shape:",
    errandsPageExample()
      .split("\n")
      .map((l) => `  | ${l}`)
      .join("\n"),
    "",
    `Job 4. Check your tools work offline: run date, git --version, node --version, and grep -rn errand ${root}/personal | head -3, and ${root}/.bin/brain search "errand". In the "My tools" section of ${help}, write one line each: works, or does not work.`,
    "",
    `You are done when both files exist. Reply with one line: done. (If the brief shows a JSON reply is needed, reply as JSON: {"edits":[{"page","text"}]} with the pages ${homePages.help} and ${homePages.errands}.)`,
  ].join("\n");
}

/** An orientation's task for an employee who works on code. */
export function engineerOrientationTask(pageRules: string): string {
  return `Read the handbook and each project's CLAUDE.md. Write what you will need as pages in your brain: one page per project under projects/, plus anything about the tools. ${pageRules} Reply as JSON: {"edits":[{"page","text"}]}.`;
}

// ---- What "done" is checked against ---------------------------------------------------------------

/** One thing an orientation must have produced, and how to tell it did. */
export interface Expectation {
  /** The page the ticket expects, for the message. */
  page: string;
  /** What to tell the agent when it is missing. */
  missing: string;
  /** How to make it, with the exact path. */
  how: string;
  /** Whether the brain's pages (slug → text) satisfy it. */
  met: (pages: ReadonlyMap<string, string>) => boolean;
}

const body = (text: string | undefined): string => (text ?? "").replace(/^---[\s\S]*?\n---\s*/, "").trim();
const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Whether a page is there with something in it (not an empty file or frontmatter alone). */
function filled(pages: ReadonlyMap<string, string>, slug: string, min = 20): boolean {
  return body(pages.get(slug)).length >= min;
}

/**
 * What an orientation ticket must have produced in the employee's own brain. A PA: its "how I help at home"
 * page (with a tools section) and its errands page. Anyone else: a page under projects/ for each project it
 * works on. An engineer with no project named still has to write something beyond the template.
 */
export function orientationExpectations(
  ticket: Pick<Ticket, "project">,
  employee: Pick<Employee, "id" | "name" | "projects">,
  isHome: boolean,
): Expectation[] {
  const root = brainRoot(employee.id);
  if (isHome) {
    return [
      {
        page: homePages.help,
        missing: `you did not write ${homePages.help}, or it has no "My tools" section`,
        how: `Write the file ${root}/personal/${homePages.help}.md (mkdir -p ${root}/personal/reference first). Copy this shape and change the words:\n${helpPageExample()}`,
        met: (pages) => filled(pages, homePages.help) && /my tools/i.test(pages.get(homePages.help) ?? ""),
      },
      {
        page: homePages.errands,
        missing: `you did not write ${homePages.errands}`,
        how: `Write the file ${root}/personal/${homePages.errands}.md (mkdir -p ${root}/personal/patterns first). Copy this shape:\n${errandsPageExample()}`,
        met: (pages) => filled(pages, homePages.errands),
      },
    ];
  }
  const named = [...new Set([...(employee.projects ?? []), ticket.project])].filter(
    (p) => p && !["General", "Home"].includes(p),
  );
  if (!named.length) {
    return [
      {
        page: "projects/<name>",
        missing: "you did not write any page beyond the template",
        how: `Write at least one page, for example ${root}/personal/tools/notes.md, starting with --- / title: / description: / --- lines.`,
        met: (pages) =>
          [...pages.keys()].some((k) => k !== "personality" && k !== "INDEX" && filled(pages, k)),
      },
    ];
  }
  return named.map((project) => {
    const slug = slugOf(project);
    return {
      page: `projects/${slug}`,
      missing: `you did not write a page for the project ${project} under projects/`,
      how: `Write the file ${root}/personal/projects/${slug}.md (mkdir -p ${root}/personal/projects first), starting with --- / title: / description: / --- lines, then what you will need to know about ${project}.`,
      met: (pages) =>
        [...pages.keys()].some((k) => k.startsWith("projects/") && k.includes(slug) && filled(pages, k)),
    };
  });
}

/** What the second session is told when the first left something out: the missing pages, and how to make each. */
export function orientationFeedback(missing: Expectation[]): string {
  return [
    "Your first session did not finish the job. Do these now, then reply done:",
    ...missing.flatMap((m, i) => [`${i + 1}. You said you were done, but ${m.missing}.`, m.how]),
  ].join("\n");
}

/** What the tidy-up's second session is told: what the brain still has wrong, as lines. */
export function tidyFeedback(left: string[]): string {
  return [
    "Your first session did not finish the tidy-up. These are still wrong in your brain copy:",
    ...left.map((l) => `- ${l}`),
    "Fix each one in the files, then reply with a short summary. Rewrite a page; do not append.",
  ].join("\n");
}
