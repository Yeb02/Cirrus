// Data model shared by the app and the server (spec 5). Records are plain JSON-serialisable objects.

export type Id = string;
export type Role = 'source' | 'target' | 'associate';
/** knowledge: an ordinary connection; inclusion: group membership; structure: a document's tree (spec 5.3, 15). */
export type ConnectionKind = 'knowledge' | 'inclusion' | 'structure';
export type PlanType = 'lobby' | 'plan' | 'document';

export interface Vec2 { x: number; y: number }

/** A word tag has no value; a key-value tag has one (spec 5.4). */
export interface TagValue { key: string; value?: string | number }

/** name: the original file name (accents included); hash: SHA-256 of the copy kept by the app. */
export interface FileRef { name: string; hash: string; size: number }

/**
 * What an annotation is about (plan 4c, D1 and D2): the PDF's node; the file's name and the hash of the version
 * annotated, which stays in the store; the page, from 1; the passage's rectangles [x0, y0, x1, y1], one per line, in
 * the page's PDF coordinates (points, y upwards, as a link's /Rect); the text highlighted. Bounds: validAnchor.
 */
export interface Anchor { pdf: Id; file: string; hash: string; page: number; rects: [number, number, number, number][]; text: string }

/** anchor: an annotation's (plan 4c, D1); otherwise a node like any other. */
export interface NodeRec { id: Id; title: string; summary: string; tags: TagValue[]; files: FileRef[]; trashedAt?: number; anchor?: Anchor }

export interface Member { node: Id; role: Role }

/**
 * inclusion: members = [{ node: member, role: 'source' }, { node: group, role: 'target' }], no text.
 * structure: tags partie:X or suivant; exists only in a document plan.
 */
export interface ConnectionRec {
  id: Id;
  kind: ConnectionKind;
  title: string;
  relation: string;
  tags: TagValue[];
  members: Member[];
  trashedAt?: number;
}

export interface PlanRec { id: Id; name: string; type: PlanType }

/** k: integer scale step (spec 8.1). */
export interface Placement { plan: Id; node: Id; x: number; y: number; k: number }

/** A branch shown in a plan; when its node is not placed in that plan it is drawn as a stub (spec 11.3). */
export interface BranchRec { plan: Id; connection: Id; node: Id }

export interface ConnectionLayout {
  plan: Id;
  connection: Id;
  marker?: Vec2;
  angle?: number;
  handles: Record<Id, { b1: Vec2; b2: Vec2 }>;
}

/**
 * node: the far node of a split arm, drawn near the bundle; center: the connection's centre, drawn near that far
 * node (node = the far node whose arm was split); absent: a member not in the plan.
 */
type PhantomOf = { kind: 'node'; node: Id } | { kind: 'center'; node: Id } | { kind: 'absent'; node: Id };

/** Fixed in its plan, placed by the user, may sit in a group like a node (spec 8.5). */
export interface PhantomRec { id: Id; plan: Id; connection: Id; of: PhantomOf; x: number; y: number; k: number; group?: Id }

type TagType = 'word' | 'number' | 'enum' | 'date' | 'text';

export interface TagKeyDef {
  key: string;
  type: TagType;
  scope: 'node' | 'connection' | 'both';
  multi: boolean;
  required: boolean;
  defaultValue?: string | number;
  /** Ordered enumeration: name and rank designate the same value. */
  enumValues?: { name: string; rank: number }[];
}

/** The global LaTeX preamble (spec 5.6), one per base; a base without one uses DEFAULT_PREAMBLE (plan 4b, D5). */
export interface PreambleRec { text: string }
