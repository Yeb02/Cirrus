import { type CompileRequest, type InjectedCite, type InjectedRef, type KnownLabel, preambleText, type State } from '@cirrus/core';
import { sameName } from '../files/merge.ts';
import { type LatexRegistry, type Origin, shortCitation, slotOf } from './registry.ts';

/**
 * What the main process needs to compile `source` as the source `origin` (D7, D8), the text as it is typed, which may
 * differ from the state's. Each label it cites without defining it: in `refs` with its definition's title and node, in
 * `broken` without one, in `doubled` with the first of several; the registry's definitions of this very source are not
 * counted, being those of the state's version of it. Each key it cites: in `cites` with the short citation of the node
 * holding it, in `doubledCites` with the first's, by identifier, when several do (shown in red, Review Focus 5), in
 * `unknownCites` when none does. Each label or key once, in the order the source first cites it. `resources`: the
 * node's files, the source itself left out; none for a relation. `known`: the hint of the slot's last compilation,
 * given as is.
 */
export function buildRequest(a: { origin: Origin; source: string; s: State; registry: LatexRegistry; known: KnownLabel[] }): CompileRequest {
  const { origin, source, s, registry } = a;
  const slot = slotOf(origin), scan = registry.scanOf(origin, source);
  const own = new Set(scan.labels.map((m) => m.name)), seen = new Set<string>();
  const refs: InjectedRef[] = [], broken: string[] = [], doubled: InjectedRef[] = [];
  for (const { name } of scan.refs) {
    if (own.has(name) || seen.has(name)) continue;
    seen.add(name);
    const defs = registry.definitions(name).filter((d) => d.origin.kind === 'title' || slotOf(d.origin) !== slot);
    if (defs.length === 0) broken.push(name);
    else (defs.length === 1 ? refs : doubled).push({ label: name, title: defs[0].title, node: defs[0].node });
  }
  const cites: InjectedCite[] = [], doubledCites: InjectedCite[] = [], unknownCites: string[] = [], keys = new Set<string>();
  for (const { name } of scan.cites) {
    if (keys.has(name)) continue;
    keys.add(name);
    // The registry's nodes, as the state has them now: one gone or in the trash since its build no longer holds the key.
    const recs = registry.citeNodes(name).map((id) => s.nodes.get(id)).filter((n) => n !== undefined && n.trashedAt === undefined);
    if (recs.length === 0) unknownCites.push(name);
    else (recs.length === 1 ? cites : doubledCites).push({ key: name, text: shortCitation(recs[0]!), node: recs[0]!.id });
  }
  const files = origin.kind === 'relation' ? [] : s.nodes.get(origin.node)?.files ?? [];
  return {
    slot, mode: origin.kind === 'file' ? 'page' : 'snippet', source, preamble: preambleText(s), refs, broken, doubled, cites, doubledCites, unknownCites,
    known: a.known,
    resources: origin.kind === 'file' ? files.filter((f) => !sameName(f.name, origin.name)) : files,
  };
}
