# Cirrus, plan 2 : socle — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** le cœur sans interface de l'app. Il comprend :
- le modèle de données partagé par l'app et le futur serveur ;
- les opérations réversibles qui le modifient ;
- les règles de cohérence ;
- les commandes métier de base ;
- l'historique et l'annulation ;
- la base locale SQLite avec son journal de changements et le stockage des fichiers ;
- une base de test artificielle qui exerce chaque fonctionnalité.

**Architecture :** trois paquets TypeScript.
- `packages/core` est pur, sans entrée-sortie : types, identifiants, opérations, état en mémoire, règles, commandes, historique. Le serveur le réutilisera au plan 5.
- `packages/store` persiste dans SQLite, avec `node:sqlite` intégré à Node et à Electron, donc sans module natif. Il tient l'état courant en tables, le journal des changements en ajout seul, et les fichiers rangés par empreinte.
- `packages/fixtures` construit la base de test artificielle.

**Tech Stack :** Node.js 26, TypeScript strict (`erasableSyntaxOnly`), npm workspaces, Vitest, `node:sqlite`.

**Spec :** `C:\Users\alpha\Desktop\Cirrus\2026-11-02-cirrus-design.md`, sections 3, 5, 6, 7, 10, 11, 12 et 17. Les décisions du plan 1 sont dans `docs/superpowers/plans/2026-11-02-cirrus-bancs-de-mesure-registre.md`.

## Global Constraints

- **Git :** on travaille sur `main`, sans branche, avec un commit puis un push sur `origin` à la fin de chaque tâche.
- **Exécution directe par Node 26 :** le TypeScript se limite à une syntaxe effaçable (`"erasableSyntaxOnly": true` : ni enum, ni namespace, ni propriété déclarée dans un constructeur), et les imports relatifs portent l'extension `.ts`. Node 26 exécute ainsi les scripts sans compilation, et Vitest comme electron-vite lisent les mêmes sources.
- **Dépendances :** aucun module natif. SQLite passe par `node:sqlite` (`DatabaseSync`), présent dans Node 26 et dans l'Electron 45 de l'app.
- **Identifiants :** chaque objet (nœud, connexion, plan, fantôme, action) a un UUID v7, ordonné dans le temps et créable hors ligne. Un changement porte un numéro local entier croissant à partir de 1, et un numéro serveur vide jusqu'à la synchro (plan 5) (spec 6.2).
- **Format (spec 3) :** les données sont en JSON dans SQLite, ni chiffrées ni obfusquées. Les fichiers sont des copies, rangées sous `files/` par empreinte SHA-256, jamais des pointeurs vers l'original (spec 5.2).
- **Opérations :** chacune porte l'état avant et l'état après d'un enregistrement entier. On l'inverse en échangeant les deux, et on n'applique une opération que si son « avant » correspond à l'état courant.
- **Annulation (spec 6.4) :** elle ajoute au journal une action inverse sans rien effacer. La pile est unique pour toute l'app et vit en mémoire.
- **Flux (spec 6.1) :** contenu (nœuds, connexions, plans, registre de tags) et disposition (placements, branches, dispositions de connexion, fantômes). Les analytics viendront plus tard.
- **Migrations :** le schéma est versionné par `PRAGMA user_version`, avec des migrations en avant seulement, dès la version 1.
- **Textes :** identifiants et commentaires en anglais, messages destinés à l'utilisateur en français.

## Review Focus

1. **Annuler un objet modifié depuis :** l'annulation est refusée proprement, avec un message, et l'état reste inchangé. Test dans la tâche 6.
2. **Action qui échoue en cours de route :** rien n'est écrit, ni dans les tables ni dans le journal, et l'état en mémoire est intact. Test dans la tâche 7.
3. **Fichiers :**
   - le même contenu importé deux fois sous deux noms donne une seule copie et deux références ;
   - les accents des noms sont conservés à l'affichage ;
   - les noms sur disque restent neutres.
   Test dans la tâche 8.
4. **Groupes :** une inclusion qui créerait une boucle, ou un second groupe direct dans le même plan, est refusée. Test dans la tâche 4.
5. **Corbeille :**
   - un nœud retiré de son dernier plan part à la corbeille et peut être restauré ;
   - une connexion qui n'a plus deux membres part à la corbeille.
   Test dans la tâche 5.

---

### Task 1 : Paquets et identifiants

**Files :**
- Modify: `package.json` (workspaces `bench/*`, `packages/*`)
- Modify: `tsconfig.base.json` (`"erasableSyntaxOnly": true`, `"allowImportingTsExtensions": true`)
- Create: `packages/core/package.json` (`"name": "@cirrus/core"`, `"type": "module"`, `"exports": "./src/index.ts"`, script `test`)
- Create: `packages/store/package.json` (`@cirrus/store`, dépend de `@cirrus/core`)
- Create: `packages/fixtures/package.json` (`@cirrus/fixtures`, dépend de `@cirrus/core` et `@cirrus/store`)
- Create: `packages/*/tsconfig.json`, `packages/*/vitest.config.ts`
- Create: `packages/core/src/ids.ts`, `packages/core/src/index.ts`
- Test: `packages/core/tests/ids.test.ts`

**Interfaces :**
- Produces : `export function uuidv7(now?: number, random?: () => number): string`. C'est le format RFC 9562 : 48 bits de millisecondes, version 7, variante 10, et des bits aléatoires (par défaut `crypto.getRandomValues`).

- [ ] **Step 1 : tests**

```ts
test('format UUID v7', () => {
  expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
test('ordonné dans le temps', () => {
  expect(uuidv7(1_000) < uuidv7(2_000)).toBe(true);
});
test('unique sur 10 000 tirages', () => {
  expect(new Set(Array.from({ length: 10_000 }, () => uuidv7())).size).toBe(10_000);
});
```

- [ ] **Step 2 : vérifier l'échec.** Run: `npm test -w packages/core`. Expected : FAIL (module absent).
- [ ] **Step 3 : implémenter les paquets et `uuidv7`.**
- [ ] **Step 4 : vérifier le succès.** Run: `npm test -w packages/core`. Expected : 3 PASS.
- [ ] **Step 5 : commit et push.** `chore: paquets du socle et identifiants UUID v7`

---

### Task 2 : Modèle et registre de tags

**Files :**
- Create: `packages/core/src/model.ts`, `packages/core/src/registry.ts`
- Test: `packages/core/tests/registry.test.ts`

**Interfaces :**
- Produces (`model.ts`) :

```ts
export type Id = string;
export type Role = 'source' | 'target' | 'associate';
export type ConnectionKind = 'knowledge' | 'inclusion' | 'structure';
export type PlanType = 'lobby' | 'plan' | 'document';
export interface Vec2 { x: number; y: number }
export interface TagValue { key: string; value?: string | number }            // mot simple : pas de value
export interface FileRef { name: string; hash: string; size: number }          // name : nom d'origine (accents compris)
export interface NodeRec { id: Id; title: string; summary: string; tags: TagValue[]; files: FileRef[]; trashedAt?: number }
export interface Member { node: Id; role: Role }
export interface ConnectionRec { id: Id; kind: ConnectionKind; title: string; relation: string; tags: TagValue[]; members: Member[]; trashedAt?: number }
// inclusion : members = [{ node: membre, role: 'source' }, { node: groupe, role: 'target' }], sans texte (spec 5.3)
// structure : tags partie:X ou suivant, n'existe que dans un plan document (spec 15)
export interface PlanRec { id: Id; name: string; type: PlanType }
export interface Placement { plan: Id; node: Id; x: number; y: number; k: number }   // k : cran d'échelle entier (spec 8.1)
export interface BranchRec { plan: Id; connection: Id; node: Id }                     // branche visible dans ce plan ; nœud non placé = amorce
export interface ConnectionLayout { plan: Id; connection: Id; marker?: Vec2; angle?: number; handles: Record<Id, { b1: Vec2; b2: Vec2 }> }
export type PhantomOf = { kind: 'node'; node: Id } | { kind: 'center' } | { kind: 'absent'; node: Id };
export interface PhantomRec { id: Id; plan: Id; connection: Id; of: PhantomOf; x: number; y: number; k: number; group?: Id } // spec 8.5, 11.3
export type TagType = 'word' | 'number' | 'enum' | 'date' | 'text';
export interface TagKeyDef { key: string; type: TagType; scope: 'node' | 'connection' | 'both'; multi: boolean; required: boolean; defaultValue?: string | number; enumValues?: { name: string; rank: number }[] }
```

- Produces (`registry.ts`) :

```ts
export function normalizeTag(tag: TagValue, defs: Map<string, TagKeyDef>): TagValue; // énumération : stockée par nom ; un rang est converti en nom ; erreur si inconnu
export function effectiveTags(tags: TagValue[], scope: 'node' | 'connection', defs: Map<string, TagKeyDef>): TagValue[]; // ajoute les défauts des clés obligatoires absentes, sans les stocker
export function enumRank(tag: TagValue, defs: Map<string, TagKeyDef>): number | undefined; // pour filtrer « ≥ 3 »
export class TagError extends Error {}
```

- [ ] **Step 1 : tests**

```ts
const defs = new Map([['statut_epistémique', { key: 'statut_epistémique', type: 'enum', scope: 'both', multi: false, required: true, defaultValue: 'sans_recul',
  enumValues: [{ name: 'douteux', rank: -1 }, { name: 'sans_recul', rank: 0 }, { name: 'consensus_scientifique', rank: 5 }] } as TagKeyDef]]);
test('le rang et le nom désignent la même valeur', () => {
  expect(normalizeTag({ key: 'statut_epistémique', value: 5 }, defs)).toEqual({ key: 'statut_epistémique', value: 'consensus_scientifique' });
  expect(enumRank({ key: 'statut_epistémique', value: 'consensus_scientifique' }, defs)).toBe(5);
});
test('valeur hors énumération refusée', () => {
  expect(() => normalizeTag({ key: 'statut_epistémique', value: 'peut-être' }, defs)).toThrow(TagError);
});
test('défaut ajouté à la lecture, jamais stocké', () => {
  const tags: TagValue[] = [{ key: 'algorithmie' }];
  expect(effectiveTags(tags, 'node', defs)).toContainEqual({ key: 'statut_epistémique', value: 'sans_recul' });
  expect(tags).toHaveLength(1);
});
```

- [ ] **Step 2 : vérifier l'échec.** Expected : FAIL.
- [ ] **Step 3 : implémenter.** Une clé inconnue du registre est acceptée telle quelle, puisque le registre se remplit au fil de l'eau.
- [ ] **Step 4 : vérifier le succès.** Expected : 3 PASS.
- [ ] **Step 5 : commit et push.** `feat(core): modèle de données et registre de tags`

---

### Task 3 : Opérations, état et application

**Files :**
- Create: `packages/core/src/ops.ts`, `packages/core/src/state.ts`
- Test: `packages/core/tests/ops.test.ts`

**Interfaces :**
- Consumes : types de la tâche 2.
- Produces :

```ts
// ops.ts — huit opérations au niveau de l'enregistrement, réversibles par échange
export type Op =
  | { t: 'node'; before: NodeRec | null; after: NodeRec | null }
  | { t: 'connection'; before: ConnectionRec | null; after: ConnectionRec | null }
  | { t: 'plan'; before: PlanRec | null; after: PlanRec | null }
  | { t: 'tagKey'; before: TagKeyDef | null; after: TagKeyDef | null }
  | { t: 'placement'; before: Placement | null; after: Placement | null }
  | { t: 'branch'; key: BranchRec; before: boolean; after: boolean }
  | { t: 'connLayout'; before: ConnectionLayout | null; after: ConnectionLayout | null }
  | { t: 'phantom'; before: PhantomRec | null; after: PhantomRec | null };
export type Flow = 'content' | 'layout';
export function flowOf(op: Op): Flow;              // node, connection, plan, tagKey → content ; le reste → layout
export function invertOp(op: Op): Op;              // échange before/after
export function subjectOf(op: Op): Id;             // id de l'objet concerné (pour l'historique par objet)
// state.ts
export interface State {
  nodes: Map<Id, NodeRec>; connections: Map<Id, ConnectionRec>; plans: Map<Id, PlanRec>; tagKeys: Map<string, TagKeyDef>;
  placements: Map<string, Placement>;   // clé `${plan}|${node}`
  branches: Set<string>;                // clé `${plan}|${connection}|${node}`
  connLayouts: Map<string, ConnectionLayout>; // clé `${plan}|${connection}`
  phantoms: Map<Id, PhantomRec>;
}
export function emptyState(): State;
export function cloneState(s: State): State;       // copie pour appliquer une action « à blanc »
export class OpConflictError extends Error {}      // l'avant d'une opération ne correspond pas à l'état
export function applyOp(s: State, op: Op): void;   // vérifie l'avant (égalité structurelle), puis écrit l'après ; null supprime
```

- [ ] **Step 1 : tests**

```ts
test('créer puis modifier un nœud', () => {
  const s = emptyState();
  const n: NodeRec = { id: 'n1', title: 'MDL', summary: '', tags: [], files: [] };
  applyOp(s, { t: 'node', before: null, after: n });
  applyOp(s, { t: 'node', before: n, after: { ...n, title: 'Minimum Description Length Principle (MDL)' } });
  expect(s.nodes.get('n1')!.title).toBe('Minimum Description Length Principle (MDL)');
});
test("l'opération inverse rétablit l'état", () => {
  const s = emptyState();
  const op: Op = { t: 'placement', before: null, after: { plan: 'p', node: 'n', x: 1, y: 2, k: 0 } };
  applyOp(s, op); applyOp(s, invertOp(op));
  expect(s.placements.size).toBe(0);
});
test('avant périmé : conflit, état intact', () => {
  const s = emptyState();
  const n: NodeRec = { id: 'n1', title: 'A', summary: '', tags: [], files: [] };
  applyOp(s, { t: 'node', before: null, after: n });
  expect(() => applyOp(s, { t: 'node', before: { ...n, title: 'autre' }, after: { ...n, title: 'B' } })).toThrow(OpConflictError);
  expect(s.nodes.get('n1')!.title).toBe('A');
});
test('flux de chaque opération', () => {
  expect(flowOf({ t: 'connection', before: null, after: null })).toBe('content');
  expect(flowOf({ t: 'branch', key: { plan: 'p', connection: 'c', node: 'n' }, before: false, after: true })).toBe('layout');
});
```

- [ ] **Step 2 : vérifier l'échec.** Expected : FAIL.
- [ ] **Step 3 : implémenter.** L'égalité structurelle compare un JSON aux clés triées. `applyOp` ne modifie rien si la vérification échoue.
- [ ] **Step 4 : vérifier le succès.** Expected : 4 PASS.
- [ ] **Step 5 : commit et push.** `feat(core): opérations réversibles et état en mémoire`

---

### Task 4 : Règles de cohérence

**Files :**
- Create: `packages/core/src/invariants.ts`
- Test: `packages/core/tests/invariants.test.ts`

**Interfaces :**
- Produces :

```ts
export interface Violation { code: 'members' | 'duplicateMember' | 'twoGroups' | 'cycle' | 'trashedPlaced' | 'structureOutsideDocument' | 'tag'; message: string; subject: Id }
export function checkState(s: State, touched?: Set<Id>): Violation[]; // touched : limite la vérification aux objets d'une action
export function groupOf(s: State, plan: Id, node: Id): Id | undefined; // groupe direct dans ce plan (via la connexion d'inclusion et ses branches)
export function ancestors(s: State, plan: Id, node: Id): Id[];         // du parent jusqu'à la racine
```

**Règles :**
- **Connexion :** une connexion de connaissance non jetée a au moins 2 membres, et un nœud n'y figure qu'une fois.
- **Groupes :** dans un plan, un nœud a au plus un groupe direct, et aucune inclusion ne forme de boucle (spec 10).
- **Corbeille :** un nœud jeté n'est placé dans aucun plan.
- **Structure :** une connexion de structure n'a de branches que dans un plan document (spec 5.3).
- **Messages :** ils sont en français, par exemple « Ce nœud est déjà dans un groupe de ce plan. »

- [ ] **Step 1 : tests.** Une fonction d'aide du fichier de test construit un petit état. Les tests :
  - `'connexion à un seul membre refusée'`
  - `'second groupe direct dans le même plan refusé (Review Focus 4)'`
  - `'boucle d'inclusion refusée (Review Focus 4)'` : A dans G, puis G dans A
  - `'deux groupes différents dans deux plans différents acceptés'`
  - `'nœud jeté encore placé refusé'`
  - `'connexion de structure hors plan document refusée'`
  - `'groupOf et ancestors suivent la hiérarchie du plan'`

  Chaque test vérifie le `code` de la violation, ou l'absence de violation.
- [ ] **Step 2 : vérifier l'échec.** Expected : FAIL.
- [ ] **Step 3 : implémenter.**
- [ ] **Step 4 : vérifier le succès.** Expected : 7 PASS.
- [ ] **Step 5 : commit et push.** `feat(core): règles de cohérence du graphe`

---

### Task 5 : Commandes métier

**Files :**
- Create: `packages/core/src/commands.ts`
- Test: `packages/core/tests/commands.test.ts`

**Interfaces :**
- Consumes : `State`, `Op`, `checkState`, `groupOf`, `uuidv7`.
- Produces : chaque commande lit l'état et renvoie une `Action`, sans rien modifier. L'action est validée, en l'appliquant à blanc sur un clone puis en appelant `checkState`, avant d'être renvoyée. En cas de violation, la commande lève une `CommandError` avec le message français.

```ts
export interface Action { id: Id; label: string; ops: Op[] }
export class CommandError extends Error {}
export function createPlan(s: State, name: string, type: PlanType): Action;
export function createNode(s: State, a: { plan: Id; title: string; x: number; y: number; k: number; summary?: string; tags?: TagValue[] }): Action;
export function editNode(s: State, id: Id, patch: Partial<Pick<NodeRec, 'title' | 'summary' | 'tags' | 'files'>>): Action;
export function moveNodes(s: State, plan: Id, moves: { node: Id; x: number; y: number; k?: number }[]): Action;
export function placeNode(s: State, plan: Id, node: Id, x: number, y: number, k: number): Action;   // ajoute un nœud existant à un plan (copier-coller, ajout au lobby)
export function removeFromPlan(s: State, plan: Id, node: Id): Action;   // spec 7 « ici seulement » ; dernier plan → corbeille ; ses branches restent (amorces)
export function deleteEverywhere(s: State, node: Id): Action;           // placements et branches retirés, nœud retiré des connexions, connexions < 2 membres jetées
export function restoreNode(s: State, node: Id, plan: Id, x: number, y: number, k: number): Action;
export function connect(s: State, a: { plan: Id; members: Member[]; title?: string; relation?: string; kind?: ConnectionKind; tags?: TagValue[] }): Action; // branches dans ce plan seulement (spec 11.1, « ici seulement »)
export function addMember(s: State, plan: Id, connection: Id, member: Member): Action;
export function removeMember(s: State, connection: Id, node: Id): Action; // partout ; < 2 membres → connexion jetée
export function setRole(s: State, connection: Id, node: Id, role: Role): Action;
export function include(s: State, plan: Id, node: Id, group: Id): Action; // remplace l'appartenance de ce plan ; réutilise la connexion d'inclusion existante (membre, groupe)
export function exclude(s: State, plan: Id, node: Id): Action;            // retire les branches d'inclusion de ce plan
export function splitArm(s: State, plan: Id, connection: Id, node: Id, near: { x: number; y: number; k: number }, far: { x: number; y: number; k: number }): Action; // spec 8.5 : deux fantômes ; branche retirée du plan
export function joinArm(s: State, plan: Id, connection: Id, node: Id): Action; // « réunir ce bras »
export function movePhantom(s: State, phantom: Id, x: number, y: number, group?: Id | null): Action; // un fantôme se place dans un groupe comme un nœud (spec 8.5)
```

La répercussion « partout » relève du plan 3, où vivent les dialogues et le placement manuel.

- [ ] **Step 1 : tests**, chacun applique l'action à un état pour vérifier son effet :
  - `'créer un nœud le place dans le plan'`
  - `'retirer un nœud de son dernier plan le met à la corbeille, restaurable (Review Focus 5)'`
  - `'retirer un nœud d'un plan garde ses branches : elles deviennent des amorces'`
  - `'supprimer partout : connexion réduite à un membre jetée (Review Focus 5)'`
  - `'connecter crée les branches dans le plan seulement'`
  - `'inclure remplace le groupe direct dans ce plan seulement'`
  - `'inclure dans un descendant lève CommandError'` : message en français
  - `'scinder un bras crée deux fantômes et retire la branche ; réunir rétablit'`
  - `'une commande ne modifie jamais l'état reçu'`
- [ ] **Step 2 : vérifier l'échec.** Expected : FAIL.
- [ ] **Step 3 : implémenter.**
- [ ] **Step 4 : vérifier le succès.** Expected : 9 PASS.
- [ ] **Step 5 : commit et push.** `feat(core): commandes métier de base`

---

### Task 6 : Historique et annulation

**Files :**
- Create: `packages/core/src/history.ts`
- Test: `packages/core/tests/history.test.ts`

**Interfaces :**
- Produces :

```ts
export function invertAction(a: Action): Action;   // opérations inversées en ordre inverse ; libellé « Annuler : … » ; nouvel id
export class UndoStack {
  record(a: Action): void;                         // une action utilisateur ; vide la pile de rétablissement
  undo(s: State): Action | null;                   // renvoie l'action inverse à valider ; null si rien à annuler
  redo(s: State): Action | null;
  get canUndo(): boolean; get canRedo(): boolean;
}
export class UndoConflictError extends Error {}    // l'objet a changé depuis : l'annulation est refusée
```

`undo` et `redo` vérifient en appliquant à blanc sur un clone. Si un « avant » ne correspond plus, ils lèvent `UndoConflictError` avec le message « Impossible d'annuler : « <libellé> » a été modifié depuis. » La pile reste alors inchangée.

- [ ] **Step 1 : tests**
  - `'annuler puis rétablir'` : créer un nœud ; l'annulation le supprime ; le rétablissement le recrée.
  - `'une nouvelle action vide la pile de rétablissement'`
  - `'objet modifié depuis : annulation refusée, état et pile intacts (Review Focus 1)'`
  - `'annuler une action multi-opérations la défait entièrement'` : `deleteEverywhere`, puis vérification de toutes les branches et connexions.
- [ ] **Step 2 : vérifier l'échec.** Expected : FAIL.
- [ ] **Step 3 : implémenter.**
- [ ] **Step 4 : vérifier le succès.** Expected : 4 PASS.
- [ ] **Step 5 : commit et push.** `feat(core): historique et annulation`

---

### Task 7 : Base locale SQLite

**Files :**
- Create: `packages/store/src/schema.ts`, `packages/store/src/localStore.ts`, `packages/store/src/index.ts`
- Test: `packages/store/tests/localStore.test.ts`

**Interfaces :**
- Consumes : `State`, `Op`, `Action`, `applyOp`, `cloneState`, `checkState`, `flowOf`, `subjectOf` (`@cirrus/core`).
- Produces :

```ts
export interface ChangeRow { localSeq: number; serverSeq: number | null; actionId: Id; label: string; flow: Flow; at: number; pc: string; subject: Id; op: Op }
export class LocalStore {
  static open(dir: string, opts: { pc: string }): LocalStore;  // crée dir, cirrus.db (WAL), applique les migrations, charge l'état
  readonly state: State;                                        // état courant en mémoire (lecture seule pour l'appelant)
  commit(a: Action): ChangeRow[];                               // tout ou rien : validation à blanc, puis une transaction (tables + journal), puis l'état en mémoire
  changesSince(localSeq: number): ChangeRow[];
  historyOf(subject: Id): ChangeRow[];                          // historique par objet (spec 6.3)
  trash(): NodeRec[];                                           // nœuds jetés
  close(): void;
}
export const SCHEMA_VERSION: number;                            // 1
```

**Schéma v1 :**

| Table | Colonnes |
|---|---|
| `nodes` | `id` (clé), `json`, `trashed` |
| `connections` | `id` (clé), `kind`, `json`, `trashed` |
| `plans` | `id` (clé), `json` |
| `tag_keys` | `key` (clé), `json` |
| `placements` | `plan`, `node` (clé composée), `json` |
| `branches` | `plan`, `connection`, `node` (clé composée) |
| `conn_layouts` | `plan`, `connection` (clé composée), `json` |
| `phantoms` | `id` (clé), `plan`, `json` |
| `changes` | `local_seq` (INTEGER PRIMARY KEY AUTOINCREMENT), `server_seq` (INTEGER UNIQUE NULL), `action_id`, `label`, `flow`, `at`, `pc`, `subject`, `op` (JSON) ; index sur `subject` et `action_id` |
| `meta` | `key`, `value` |

`schema.ts` applique les migrations dans l'ordre, de `user_version` + 1 à `SCHEMA_VERSION`.

- [ ] **Step 1 : tests** (dossier temporaire par test)
  - `'ouvrir crée la base au schéma courant'` : `PRAGMA user_version` = 1.
  - `'une action validée persiste et se recharge à la réouverture'`
  - `'le journal reçoit une ligne par opération, numéros locaux croissants, numéro serveur vide'`
  - `'action invalide : rien écrit, ni tables ni journal, état intact (Review Focus 2)'` : une action dont la 2e opération a un « avant » périmé.
  - `'historique par objet'` : trois modifications d'un nœud, `historyOf` en renvoie trois.
  - `'corbeille'` : un nœud retiré de son dernier plan apparaît dans `trash()`.
- [ ] **Step 2 : vérifier l'échec.** Expected : FAIL.
- [ ] **Step 3 : implémenter.** Une seule transaction `BEGIN IMMEDIATE … COMMIT` par action, `ROLLBACK` sur toute erreur, et l'état en mémoire n'est mis à jour qu'après le `COMMIT`.
- [ ] **Step 4 : vérifier le succès.** Expected : 6 PASS.
- [ ] **Step 5 : commit et push.** `feat(store): base locale SQLite et journal des changements`

---

### Task 8 : Fichiers des nœuds

**Files :**
- Create: `packages/store/src/files.ts`
- Test: `packages/store/tests/files.test.ts`

**Interfaces :**
- Produces :

```ts
export function importFile(storeDir: string, srcPath: string): FileRef; // copie dans files/<2 premiers hex>/<sha256>, une seule fois par contenu ; name = nom d'origine
export function filePath(storeDir: string, ref: FileRef): string;        // chemin de la copie (nom neutre)
```

- [ ] **Step 1 : tests**
  - `'importer copie le fichier ; modifier l'original n'affecte pas la copie'` (spec 5.2)
  - `'même contenu sous deux noms : une copie, deux références (Review Focus 3)'`
  - `'nom accentué conservé à l'affichage, nom neutre sur disque (Review Focus 3)'` : `Enoncé_détaillé.tex` → `ref.name === 'Enoncé_détaillé.tex'`, et `filePath` ne contient que `[0-9a-f/\\:.A-Za-z_-]`.
- [ ] **Step 2 : vérifier l'échec.** Expected : FAIL.
- [ ] **Step 3 : implémenter.** On utilise `crypto.createHash('sha256')` en flux, et l'écriture passe par un fichier temporaire suivi d'un renommage.
- [ ] **Step 4 : vérifier le succès.** Expected : 3 PASS.
- [ ] **Step 5 : commit et push.** `feat(store): fichiers des nœuds rangés par empreinte`

---

### Task 9 : Base de test artificielle

**Files :**
- Create: `packages/fixtures/src/build.ts`, `packages/fixtures/src/index.ts`, `packages/fixtures/scripts/make-fixture.ts`
- Create: `packages/fixtures/assets/` (un `.tex`, un `.py`, un petit `.png`, un petit `.pdf`)
- Test: `packages/fixtures/tests/build.test.ts`

**Interfaces :**
- Consumes : commandes (tâche 5), `UndoStack` (tâche 6), `LocalStore` (tâche 7), `importFile` (tâche 8).
- Produces : `export function buildFixture(store: LocalStore, storeDir: string): FixtureIds;`, où `FixtureIds` nomme les objets clés pour les tests des plans suivants. On a aussi le script `npm run fixture -w packages/fixtures -- <dossier>`.

**Contenu imposé** (chaque fonctionnalité au moins une fois) :
- **Plans :** un lobby, un plan « Thèse », un plan document « Article MDL ».
- **Registre de tags :**
  - `statut_epistémique` et `pertinence`, énumérations ordonnées et obligatoires avec défaut ;
  - `nature` et `provenance` ;
  - `auteur` multivalué et `date_de_publication`.
- **Nœuds de l'exemple de l'utilisateur :**
  - « Minimum Description Length Principle (MDL) », avec son résumé et ses tags, et dans son dossier `Enoncé_détaillé.tex` et `calcul_mdl_séquence_aléatoire.py` ;
  - « Induction de Solomonoff » ;
  - « Universalité algorithmique » ;
  - « Monde algorithmique ».
  Une vingtaine d'autres nœuds complètent la base.
- **Connexions :**
  - la connexion MDL–Solomonoff de l'exemple, avec sa relation et le tag `parallèle` ;
  - une connexion 2 vers 1, une 2 vers 2, et une paire d'associés.
- **Groupes et plans :**
  - des groupes imbriqués sur trois niveaux dans le lobby ;
  - un groupe différent pour le même nœud dans « Thèse » ;
  - un nœud exclusif à « Thèse » ;
  - une amorce, c'est-à-dire un nœud de la connexion absent du plan.
- **Bras scindé :** avec ses deux fantômes, dont l'un est placé dans un groupe.
- **Document :** une racine, des parties `partie:1` à `partie:3`, une sous-partie et une chaîne de suivants dans « Article MDL ».
- **Fichiers et publications :** un nœud de publication avec son PDF et les tags `auteur` ×2 et `date_de_publication`, une image.
- **Corbeille et historique :** un nœud à la corbeille, et un historique comportant une action annulée.

- [ ] **Step 1 : tests**
  - `'la base de test se construit sans violation'` : `checkState(store.state)` est vide.
  - `'chaque fonctionnalité est présente'` : comptes et présence par catégorie (plans par type, connexions par sorte, fantômes, profondeur d'imbrication 3, corbeille non vide, action annulée dans le journal).
  - `'réouverture identique'` : fermer, rouvrir, l'état est égal.
- [ ] **Step 2 : vérifier l'échec.** Expected : FAIL.
- [ ] **Step 3 : implémenter `buildFixture` et le script.**
- [ ] **Step 4 : vérifier le succès.** Run: `npm test --workspaces`. Expected : toutes les suites PASS.
- [ ] **Step 5 : commit et push.** `feat(fixtures): base de test artificielle`
