export interface Vec2 { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

export type Role = 'source' | 'target' | 'associate';

/** parent = -1 at top level; r > 0 only for a group (radius of the disc holding its members). */
export interface SceneNode { id: number; x: number; y: number; k: number; parent: number; r: number; title: string }

/** display 'stubs': drawn as short links from each endpoint toward a phantom of the far end (spec 8.5). */
export interface SceneConnection { id: number; members: { node: number; role: Role }[]; display?: 'full' | 'stubs' }

export interface Scene { nodes: SceneNode[]; connections: SceneConnection[]; children: number[][] }

/** (x, y) = world point at the screen centre; zoom = screen px per world unit. */
export interface Camera { x: number; y: number; zoom: number; widthPx: number; heightPx: number }
