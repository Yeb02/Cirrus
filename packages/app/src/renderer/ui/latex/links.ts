import type { Id } from '@cirrus/core';
import { externalUrlAllowed } from '../../../main/navigation.ts';

/** The address a compiled \ref or \cite links to (plan 4b, D7; the driver's \cirrus@link), an app identifier after it. */
const NODE_LINK = /^cirrus:\/\/node\/([0-9a-f-]{36})$/;

/** The node a `cirrus://node/<id>` link leads to, if `<id>` is an identifier of the app; else null. */
export function nodeLinkOf(url: string): Id | null {
  return NODE_LINK.exec(url)?.[1] ?? null;
}

/** Where a link of a PDF leads: a node of the base, an address for the system (openUrl), a destination in the document. */
export type LinkTarget = { node: Id } | { url: string } | { dest: unknown };

/**
 * A link annotation of pdf.js (plan 4a, task 6; plan 4b, task 6): a `cirrus://node/<id>` address, which pdf.js leaves
 * unvalidated (`unsafeUrl` only), leads to that node, and never reaches the system; an address pdf.js validated (`url`)
 * that externalUrlAllowed takes — http:, https:, mailto: — goes to the system; else its destination in the document.
 * Any other — another scheme, cirrus: or not, an action, an attachment — is no link (null).
 */
export function linkTarget(a: { url?: string; unsafeUrl?: string; dest?: unknown }): LinkTarget | null {
  const raw = a.unsafeUrl ?? a.url;
  const node = typeof raw === 'string' ? nodeLinkOf(raw) : null;
  if (node !== null) return { node };
  if (typeof a.url === 'string' && externalUrlAllowed(a.url)) return { url: a.url };
  if (a.url === undefined && a.unsafeUrl === undefined && a.dest !== undefined && a.dest !== null) return { dest: a.dest };
  return null;
}
