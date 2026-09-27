# Ten tells of a generic UI

Based on "10 tells of a slop ui" by hereticpleb (September 2026,
https://hereticpleb.vercel.app/blog/10-tells-of-slop). This is our own summary, written as review
questions. The article is an opinionated critique, not a rulebook: a pattern is a problem when it
carries no meaning for this product, not because it appears.

| # | Tell | Ask | Fix when it's empty |
| --- | --- | --- | --- |
| 1 | Gradients everywhere | Does any gradient encode something, or is it the identity by default? | Flat, stable surfaces for work; one justified treatment at most. Build hierarchy with size, spacing and contrast |
| 2 | Colour without meaning | Can you name what each colour means? Does one colour mean two things, or two colours one thing? | A small palette by role: surfaces, text, actions, and each status. Same meaning, same colour, everywhere |
| 3 | Redundant or pulsing badges | Does the badge change a decision? Is the same state shown twice nearby? Does anything pulse without a transient event? | Show a state once per view, quietly; motion only for a real change |
| 4 | Accent-edge cards | Is there a coloured strip on the edge of rounded cards? Is everything a card? | Drop the strip; use rows, tables or dividers for records, cards only for independent objects |
| 5 | Decorative emoji | Are emoji standing in for icons or bullets? | Text, or one consistent icon set, for controls; emoji only as user content |
| 6 | Misalignment | Do markers sit on their track, icons on the text's line, columns on one edge? | Align to shared tracks; fix the component geometry, not per-item nudges. Run the checker |
| 7 | Default type and programming costume | Is monospace, `//` or terminal styling used on plain prose because the product is technical? Is there a real type hierarchy? | Monospace only for code, paths and identifiers; give display, body and data type distinct roles |
| 8 | Prompt residue | Does copy describe how the UI was built, or echo the brief, instead of helping the user? | Delete it, or turn it into a concrete capability or state |
| 9 | Glass and ready-made skins | Is blur or translucency (or any stock look: brutalism, cream-and-serif) the whole identity? | Opaque reading surfaces; derive the look from the product's own world |
| 10 | Generic taglines and hype | Could this headline move to another product unchanged? Is there a grey subtitle under every title? | Name the actual thing, task or state; cut text the UI already explains |
