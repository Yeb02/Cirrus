/** What the graph shows over its background that asks something of the user: a question (AskDialog), its context menu. */
export interface Overlays { question: boolean; menu: boolean }

/**
 * Whether the search box closes as the graph's overlays change (plan 6a, final review): when a question or the menu
 * opens — not when one closes, nor when one was open already. The box is a list as tall as the graph, and a question
 * asked while it is open (Suppr on a node clicked meanwhile, « Voir dans un autre plan ») would be live, its first
 * choice focused, under it; a blind Entrée would answer it.
 */
export function overlayClosesSearch(before: Overlays, after: Overlays): boolean {
  return (after.question && !before.question) || (after.menu && !before.menu);
}
