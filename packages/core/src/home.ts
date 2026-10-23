// What a personal assistant is told, and what "done" means for the tickets that teach it (spec §5, §7).
//
// A PA's sandbox has no internet and no root, and its model is a small local one (an 8B model on Ollama,
// reached through the relay). So its briefs are short, name the exact path of every file it should write,
// say what the machine does not have, and show the page format to copy. Pure: the daemon feeds these
// into briefs and turns, and the runner checks them when an orientation or a tidy-up ends.
import { brainRoot } from "./brain-prompt.ts";
import type { Employee, Ticket } from "./model.ts";
import { parsePage, wordCount } from "./page.ts";

/** The two pages a PA's orientation must leave in its own brain (folder/name, as the daemon files them). */
export const homePages = {
  help: "reference/how-i-help-at-home",
  errands: "patterns/errands",
} as const;

/** The page an engineer writes when the company has no project yet: what it found out about its tools. */
export const toolsPage = "reference/my-tools";

/** What a PA's machine is known to have, as far as the daemon has seen it. */
export interface HomeTools {
  /** `brain search` works (false when the sandbox's Node can't do SQLite FTS5). Default: yes. */
  search?: boolean;
  /** ripgrep is on the path. Default: no (not known to be there), and the note says `grep -rn`. */
  rg?: boolean;
}

/**
 * What the PA's machine has and hasn't. It goes in every brief and every conversation turn of a PA, because
 * a small model that is not told tries `sudo apt install` (Pip did, on 2026-10-22) and gives up when it fails.
 * `root` is where its brain copy is, so the commands can be copied as they are. It matches the image
 * (images/employee/Dockerfile): `gh` and `docker` are installed, but cannot reach anything offline.
 */
export function offlineNotes(employeeId: string, tools: HomeTools = {}): string {
  const root = brainRoot(employeeId);
  const search = tools.search !== false;
  return [
    "Your machine (read once, it does not change):",
    "- It has NO internet, no sudo and no root. apt, npm install, pip and curl to the web all fail. Do not try them.",
    `- You have: a shell (bash, ls, cat, head, tail, sed, find, wc, grep, git, node, jq${tools.rg ? ", rg" : ""}) and your file tools (read, write, edit, glob, grep).${
      search ? ` The brain command: ${root}/.bin/brain search "words".` : ""
    }`,
    `- Your brain copy is the folder ${root}/ (your own pages are in ${root}/personal/).${
      search ? "" : " `brain search` does not work here: read the INDEX.md files and use grep -rn."
    }`,
    tools.rg
      ? '- To search text, use rg "words" <folder>, or grep -rn "words" <folder>.'
      : '- To search text, use: grep -rn "words" <folder>.',
    "- gh and docker are installed but cannot be used: they need the internet. Not available at all: sudo, apt, python, a browser. Do not install anything.",
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

const toolsSection = [
  "## My tools",
  "- shell: works",
  "- git: works",
  "- brain search: works",
  "- internet, sudo, installs: not available",
];

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
    ...toolsSection,
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
  const quoted = (text: string) =>
    text
      .split("\n")
      .map((l) => `  | ${l}`)
      .join("\n");
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
    "  Copy this shape, then rewrite every bullet in your own words so it is true for you (at least 40 words in all). A copy of the example is not accepted:",
    quoted(helpPageExample()),
    "",
    `Job 3. Write the file ${errands}`,
    `  First: mkdir -p ${root}/personal/patterns`,
    "  Copy this shape and make it yours (at least 40 words; no TODO lines):",
    quoted(errandsPageExample()),
    "",
    `Job 4. Check your tools work offline: run date, git --version, node --version, and grep -rn errand ${root}/personal | head -3, and ${root}/.bin/brain search "errand". In the "My tools" section of ${help}, write one line each: works, or does not work.`,
    "",
    `You are done when both files exist. Reply with one line: done. (If the brief shows a JSON reply is needed, reply as JSON: {"edits":[{"page","text"}]} with the pages ${homePages.help} and ${homePages.errands}.)`,
  ].join("\n");
}

/** An orientation's task for an employee who works on code: the exact pages, named. */
export function engineerOrientationTask(
  employee: Pick<Employee, "id">,
  pages: { page: string }[],
  pageRules: string,
): string {
  const root = brainRoot(employee.id);
  return [
    "Read the handbook and each project's CLAUDE.md. Write what you will need as pages in your brain. Write exactly these pages, each starting with --- / title: / description: / --- lines and at least 40 words of what you learned (no TODO lines):",
    ...pages.map((p) => `- ${p.page}  (the file ${root}/personal/${p.page}.md)`),
    pageRules,
    'Reply as JSON: {"edits":[{"page","text"}]}, or write the files in your brain copy.',
  ].join("\n");
}

// ---- What "done" is checked against ---------------------------------------------------------------

/** One thing an orientation must have produced, and how to tell it did. */
export interface Expectation {
  /** The page the ticket expects. Every `problem` starts with it, so a retry can find its own. */
  page: string;
  /** How to make it, with the exact path. */
  how: string;
  /**
   * What is wrong with the brain's pages (page → text, only pages THIS ticket's sessions wrote or changed), or
   * null when the page is there and good: with frontmatter that has a title and a description, at least
   * `minWords` words of body, no repeated TODO, and not the example copied.
   */
  problem: (pages: ReadonlyMap<string, string>) => string | null;
}

const minWords = 40;
const minDistinct = 20;
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Why a page is not a real one, or null. The example a PA is shown is a shape to copy: handed back as it is (apart
 * from the tools section, which records what it found), it is a placeholder, not a page.
 */
export function pageProblem(text: string, slug: string, example?: string): string | null {
  const parsed = parsePage(text, slug);
  if (!parsed.hasFrontmatter || parsed.derived.title || parsed.derived.description) {
    return "it has no frontmatter with a title and a description";
  }
  const words = wordCount(parsed.body);
  if (words < minWords) return `its body is ${words} words, under ${minWords}`;
  const distinct = new Set((parsed.body.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) as string[]).size;
  if (distinct < minDistinct)
    return `it uses only ${distinct} different words, under ${minDistinct}: it repeats itself`;
  if ((parsed.body.match(/\bTODO\b/gi) ?? []).length >= 2) return "it still has TODO placeholders";
  if (example) {
    const want = parsePage(example, slug).body.split("## My tools")[0] ?? "";
    const got = parsed.body.split("## My tools")[0] ?? "";
    const lines = (t: string) => t.split("\n").map(squash).filter(Boolean);
    const have = new Set(lines(got));
    const same = lines(want).filter((l) => have.has(l)).length;
    const extra = lines(got).filter((l) => !lines(want).includes(l)).length;
    // Most of the example's lines still there, whether or not a line or two was edited or added.
    if (same >= Math.ceil(lines(want).length * 0.6) && extra <= 3) {
      return "it is the example copied as it is: write it in your own words";
    }
  }
  return null;
}

/** An expectation for one page: missing, or not good. */
function pageExpectation(
  page: string,
  how: string,
  example?: string,
  also?: (text: string) => string | null,
): Expectation {
  return {
    page,
    how,
    problem: (pages) => {
      const text = pages.get(page);
      if (text === undefined) return `${page}: you did not write it in this ticket`;
      const why = pageProblem(text, page, example) ?? also?.(text) ?? null;
      return why ? `${page}: ${why}` : null;
    },
  };
}

const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * What an orientation ticket must have produced in the employee's own brain, by this ticket's sessions (a page
 * left by an earlier run does not count). A PA: its "how I help at home" page (with a tools section) and its
 * errands page. Anyone else: a page under projects/ for each project it works on (`allProjects` when none is
 * named: the company's), or, when the company has no project yet, `reference/my-tools`.
 */
export function orientationExpectations(
  ticket: Pick<Ticket, "project">,
  employee: Pick<Employee, "id" | "name" | "projects">,
  isHome: boolean,
  allProjects: string[] = [],
): Expectation[] {
  const root = brainRoot(employee.id);
  if (isHome) {
    return [
      pageExpectation(
        homePages.help,
        `Write the file ${root}/personal/${homePages.help}.md (mkdir -p ${root}/personal/reference first). Copy this shape and rewrite it in your own words:\n${helpPageExample()}`,
        helpPageExample(),
        (text) => (/my tools/i.test(text) ? null : 'it has no "My tools" section'),
      ),
      pageExpectation(
        homePages.errands,
        `Write the file ${root}/personal/${homePages.errands}.md (mkdir -p ${root}/personal/patterns first). Copy this shape and make it yours:\n${errandsPageExample()}`,
        errandsPageExample(),
      ),
    ];
  }
  const named = [...new Set([...(employee.projects ?? allProjects), ticket.project])].filter(
    (p) => p && !["General", "Home"].includes(p),
  );
  if (!named.length) {
    return [
      pageExpectation(
        toolsPage,
        `Write the file ${root}/personal/${toolsPage}.md (mkdir -p ${root}/personal/reference first), starting with --- / title: / description: / --- lines, then what you found out about your tools and machine.`,
      ),
    ];
  }
  return named.map((project) => {
    const slug = slugOf(project);
    const page = `projects/${slug}`;
    const how = `Write the file ${root}/personal/${page}.md (mkdir -p ${root}/personal/projects first), starting with --- / title: / description: / --- lines, then what you will need to know about ${project}.`;
    // A page under projects/ that names the project counts, whatever its exact name.
    return {
      page,
      how,
      problem: (pages) => {
        const found = [...pages.keys()].filter((k) => k.startsWith("projects/") && k.includes(slug));
        if (!found.length)
          return `${page}: you did not write a page for the project ${project} in this ticket`;
        const why = found.map((k) => pageProblem(pages.get(k) ?? "", k)).filter((w) => w !== null);
        return why.length === found.length ? `${page}: ${why[0]}` : null;
      },
    };
  });
}

/** What the second session is told when the first left something out: what is wrong with each page, and how to make it. */
export function orientationFeedback(redo: { problem: string; how: string }[]): string {
  return [
    "Your first session did not finish the job. Do these now, then reply done:",
    ...redo.flatMap((m, i) => [`${i + 1}. ${m.problem} (you said you were done).`, m.how]),
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
