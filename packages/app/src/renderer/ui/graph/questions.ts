import type { Id } from '@cirrus/core';
import { deleteSummary, otherPlans, type PlanScene } from '@cirrus/view';
import { useRef, useState } from 'react';
import { addMemberBuild, deleteBuild, deleteConnectionBuild, hideBuild, lastPlanNodes, removeMemberBuild } from '../../actions.ts';
import type { Question } from '../Dialogs.tsx';
import { type Graph, plural } from './core.ts';
import { connectionElsewhere, connectionPlans, memberElsewhere, memberPlans, nodesElsewhere } from './where.ts';

/**
 * The question the graph asks (AskDialog), and those it asks before an edit (spec 7, 11, 19): where a connection or a
 * member goes, what hiding or deleting sends to the trash.
 */
export function useQuestions(graph: Graph) {
  const { sceneRef, paramsRef, stateRef, edit } = graph;
  const [question, setQuestion] = useState<Question | null>(null);
  const questionRef = useRef(question);
  questionRef.current = question;
  /** Whether a question is open. */
  const asking = () => questionRef.current !== null;
  /** « Partout ou ici seulement » (spec 11, 19), asked only when other plans are concerned; `go` gets the plans chosen. */
  const askWhere = (text: string, plans: Id[], go: (everywhere: Id[]) => void) => {
    if (plans.length === 0) { go([]); return; }
    const names = plans.map((id) => stateRef.current.plans.get(id)?.name ?? '?');
    const n = plans.length, s = n > 1 ? 's' : '';
    const here = { value: 'here', label: 'Ici seulement' }, all = { value: 'everywhere', label: `Partout (${n} autre${s} plan${s})` };
    setQuestion({
      text, detail: `Autre${s} plan${s} concerné${s} : ${names.join(', ')}.`,
      choices: paramsRef.current.defaultAnswer === 'everywhere' ? [all, here] : [here, all],
      answer: (v) => { if (v !== null) go(v === 'everywhere' ? plans : []); },
    });
  };
  /** « Voir dans un autre plan » (plan 6a, D3) with several plans: they are listed by name, in the order given; `go` gets the one chosen. */
  const askPlan = (text: string, plans: Id[], go: (plan: Id) => void) => {
    setQuestion({
      text, choices: plans.map((id) => ({ value: id, label: stateRef.current.plans.get(id)?.name ?? '?' })),
      answer: (v) => { if (v !== null) go(v); },
    });
  };
  /**
   * Adding a member to a connection from its pop-up (spec 11.2), in the plan shown: also in the other plans where the
   * connection is shown, if the answer is « partout ».
   */
  const addMember = (connection: Id, node: Id) => {
    const plan = sceneRef.current?.plan.id;
    if (!plan) return;
    askWhere('Ajouter aussi ce nœud à la connexion dans les autres plans où elle est affichée ?',
      otherPlans(stateRef.current, plan, [node], connection), (everywhere) => edit(addMemberBuild(plan, connection, node, everywhere)));
  };
  /**
   * Removing a member of a connection (spec 11.2, 7): here only or everywhere, with its plans counted, a warning for the
   * last ones; shown in no other plan, it leaves at once, « partout » (where.ts).
   */
  const removeMember = (connection: Id, node: Id) => {
    const s = stateRef.current, plan = sceneRef.current?.plan.id, c = s.connections.get(connection);
    if (!c || !plan) return;
    if (!memberElsewhere(s, plan, connection, node)) { edit(removeMemberBuild(plan, connection, node, true)); return; }
    const shownIn = memberPlans(s, connection, node);
    const last = c.members.length <= 2;
    const choices = [
      ...(shownIn.includes(plan) ? [{ value: 'here', label: 'Ici seulement' }] : []),
      { value: 'everywhere', label: last ? 'Partout (supprime la connexion)' : 'Partout' },
    ];
    if (paramsRef.current.defaultAnswer === 'everywhere') choices.reverse();
    const n = shownIn.length;
    setQuestion({
      text: `Retirer « ${s.nodes.get(node)?.title ?? '?'} » de la connexion ?`,
      detail: `Ce membre est affiché dans ${n} plan${n > 1 ? 's' : ''}.${last ? ' La connexion n’aurait plus qu’un membre : « partout » la met à la corbeille.' : ''}`,
      choices,
      answer: (v) => { if (v !== null) edit(removeMemberBuild(plan, connection, node, v === 'everywhere')); },
    });
  };
  /** Node titles for a question: « A », « B » et 2 autres. */
  const titles = (ids: Id[]): string => {
    const t = ids.slice(0, 2).map((id) => `« ${stateRef.current.nodes.get(id)?.title ?? '?'} »`).join(', ');
    return ids.length > 2 ? `${t} et ${ids.length - 2} autre${ids.length > 3 ? 's' : ''}` : t;
  };
  /** What goes to the trash, said for a question: nothing, or these nodes, this plan being their last (spec 7). */
  const trashNote = (last: Id[]) => (last.length === 0 ? 'rien ne part à la corbeille'
    : `${titles(last)} ${plural(last.length, 'ira', 'iront')} à la corbeille (dernier plan)`);
  /**
   * « Cacher » (spec 7): a group asks whether its content follows; what would leave its last plan is announced, for each
   * answer, content included (I12 of the plan 3b review).
   */
  const askHide = (sc: PlanScene, items: number[]) => {
    const ids = items.filter((i) => sc.items[i].kind !== 'phantom').map((i) => sc.items[i].id);
    if (ids.length === 0) return;
    const s = stateRef.current, groups = items.filter((i) => sc.items[i].kind === 'group');
    const alone = lastPlanNodes(s, sc, ids, false), all = lastPlanNodes(s, sc, ids, true);
    if (groups.length === 0 && alone.length === 0) { edit(hideBuild(sc, ids)); return; }
    setQuestion({
      text: groups.length > 0 ? `Cacher ${plural(groups.length, 'ce groupe', 'ces groupes')} : le contenu suit-il ?` : `Cacher ${titles(ids)} ?`,
      detail: groups.length > 0 ? `Avec le contenu, ${trashNote(all)}. Seul, ${trashNote(alone)}.` : `${trashNote(alone)[0].toUpperCase()}${trashNote(alone).slice(1)}.`,
      choices: groups.length > 0
        ? [{ value: 'content', label: 'Avec le contenu' }, { value: 'alone', label: plural(groups.length, 'Le groupe seul', 'Les groupes seuls') }]
        : [{ value: 'alone', label: 'Cacher' }],
      answer: (v) => { if (v !== null) edit(hideBuild(sc, ids, v === 'content')); },
    });
  };
  /**
   * Deletion (spec 7): « partout » or « ici seulement », with the instances counted and the last ones announced; « ici »
   * for a group asks whether its content follows (I12 of the plan 3b review). Nodes in no other plan are deleted at once,
   * « partout » (where.ts: nor shown there as a stub or a phantom, nor an annotation, which lives under its PDF); a group
   * among them still asks whether its content follows.
   */
  const askDelete = (sc: PlanScene, items: number[]) => {
    const ids = items.filter((i) => sc.items[i].kind !== 'phantom').map((i) => sc.items[i].id);
    if (ids.length === 0) return;
    const s = stateRef.current, { instances } = deleteSummary(s, ids);
    const groups = items.some((i) => sc.items[i].kind === 'group');
    const alone = lastPlanNodes(s, sc, ids, false), all = lastPlanNodes(s, sc, ids, true);
    if (!nodesElsewhere(s, sc.plan.id, ids)) {
      if (!groups) { edit(deleteBuild(sc, ids, true)); return; }
      // « Le groupe seul » deletes everywhere: every one of them goes to the trash (none is an annotation, which would
      // figure elsewhere, under its PDF); with the content, each leaves this plan (lastPlanNodes: annotations stay).
      setQuestion({
        text: `Supprimer ${titles(ids)} : le contenu suit-il ?`,
        detail: `Avec le contenu, ${trashNote(all)}. Seul, ${trashNote(ids)}.`,
        choices: [
          { value: 'content', label: 'Avec le contenu' },
          { value: 'everywhere', label: plural(items.filter((i) => sc.items[i].kind === 'group').length, 'Le groupe seul', 'Les groupes seuls') },
        ],
        answer: (v) => { if (v !== null) edit(deleteBuild(sc, ids, v === 'everywhere', v === 'content')); },
      });
      return;
    }
    const here = groups
      ? [{ value: 'content', label: 'Ici, avec le contenu' }, { value: 'here', label: 'Ici, le groupe seul' }]
      : [{ value: 'here', label: 'Ici seulement' }];
    const everywhere = { value: 'everywhere', label: 'Partout' };
    setQuestion({
      text: `Supprimer ${titles(ids)} ?`,
      detail: `${plural(ids.length, 'Il figure', 'Ils figurent')} dans ${instances} plan${instances > 1 ? 's' : ''} en tout. `
        + (groups ? `Ici avec le contenu, ${trashNote(all)} ; ici seul, ${trashNote(alone)}.` : `Ici, ${trashNote(alone)}.`),
      choices: paramsRef.current.defaultAnswer === 'everywhere' ? [everywhere, ...here] : [...here, everywhere],
      answer: (v) => { if (v !== null) edit(deleteBuild(sc, ids, v === 'everywhere', v === 'content')); },
    });
  };
  /**
   * A connection's deletion (spec 7): « ici seulement » hides it here, « partout » sends it to the trash; shown in no
   * other plan, it goes to the trash at once (where.ts).
   */
  const askDeleteConnection = (plan: Id, connection: Id) => {
    const s = stateRef.current, c = s.connections.get(connection);
    if (!c) return;
    if (!connectionElsewhere(s, plan, connection)) { edit(deleteConnectionBuild(plan, connection, true)); return; }
    const n = connectionPlans(s, connection).length;
    const here = { value: 'here', label: 'Ici seulement' }, all = { value: 'everywhere', label: 'Partout' };
    setQuestion({
      text: `Supprimer la connexion${c.title ? ` « ${c.title} »` : ''} ?`,
      detail: `Elle est affichée dans ${n} plans.`,
      choices: paramsRef.current.defaultAnswer === 'everywhere' ? [all, here] : [here, all],
      answer: (v) => { if (v !== null) edit(deleteConnectionBuild(plan, connection, v === 'everywhere')); },
    });
  };
  return { question, setQuestion, asking, askWhere, askPlan, addMember, removeMember, titles, askHide, askDelete, askDeleteConnection };
}

export type QuestionsPart = ReturnType<typeof useQuestions>;
