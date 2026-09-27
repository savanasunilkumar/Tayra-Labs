# Product interface reference review

Inspected the user's authenticated apps in Safari, without submitting requests or modifying their data:

- Linear: agent view and workspace project list.
- Twelve Labs: product home, Analyze, and My Data / Assets list.

## Observed patterns to apply

Linear uses a nearly black, approximately 240px sidebar; an inset content surface with a thin boundary and modest corner radius; a 44px title/action bar; 13–14px interface typography; low-contrast monochrome navigation; 28–32px navigation rows; flat toolbars and lists. Its project list does not surround each row or section with a dashboard card. Primary information sits near the top; remaining space is allowed to stay empty.

Twelve Labs is workflow-led: select a video, enter a prompt, adjust parameters, analyze, inspect output. Its analysis controls are a narrower column beside the output. Its media view uses a straightforward toolbar, view controls, and metadata columns. Operational infrastructure details are not the main navigation or headline.

## Tayra decisions

- Use Linear's shell proportions and restrained visual hierarchy, with the media-analysis workflow observed in Twelve Labs.
- Primary destinations: Overview (history) and Analyze (new requests), per the user's navigation correction; supporting model and developer pages remain separate.
- Remove the generic overview metric cards, promotional banner, purple icon tiles, sparkle/eye decorations, oversized empty-state illustration, global connection badge and development label.
- Use Lucide icons directly, with official shadcn sidebar, avatar, command, table, select and action primitives. The earlier custom Glyph component has been removed. Keep the supplied Tayra mark.
- Keep only the Tayra Labs brand at the top; place the profile menu below Settings in the sidebar footer.
- Do not insert example jobs into the user's analysis list. Preserve historical records; offer the saved example separately.
- Move connection diagnostics and infrastructure specifics into Settings. Show actual service unavailability only where it blocks an action; do not pretend the paused backend is available.
- No invented customer records, API keys, metrics, models, or production deployment claims.

Reference accounts' project names, uploaded media, IDs and screenshots are not copied into Tayra or this document. No actions were taken in those products beyond navigation.
