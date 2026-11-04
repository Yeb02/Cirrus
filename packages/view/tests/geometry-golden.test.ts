import type { Vec2 } from '@cirrus/core';
import { expect, test } from 'vitest';
import type { Camera } from '../src/camera.ts';
import { bundleFor } from '../src/frame.ts';
import type { BundleGeometry } from '../src/geometry/bundle.ts';
import { offsetPolygon } from '../src/geometry/hull.ts';
import { appendBundleGlyphs, newGlyphMeshes } from '../src/geometry/ribbon.ts';
import { isSimple } from '../src/instances.ts';
import { buildScene } from '../src/scene.ts';
import { buildIndex, computeVisible } from '../src/visibility.ts';
import { fixture, measure, P } from './helpers.ts';

/**
 * Numbers given by the code of commit 9064ac0, before plan 3c task 9 rewrote the bundles' geometry, their glyphs and
 * the padded polygon without allocations (bundle.ts, ribbon.ts, hull.ts): the rewrite gives them to the bit, and any
 * later drift fails here before a capture shows it. -0 reads as 0 (JSON).
 */
const AT_9064AC0 = {"multi":{"title":"Déduction jointe","g":{"marker":[317.8333333333333,85.33333333333333],"u":[0.9967057746336059,0.08110239707939405],"trunk":[292.91568896749317,83.30577340634848,342.75097769917346,87.36089326031818],"branches":[[-107.96069022944707,-97,24.328514905543216,-37.499094775905,51.9546868643221,63.698668310158965,292.91568896749317,83.30577340634848],[-80,132.69608638286837,43.06217735927275,116.3972831006168,86.70254402574298,66.52611707275852,292.91568896749317,83.30577340634848],[235.9935949438077,111,254.7778859716239,101.86090522409499,258.2144898782134,80.48212123206018,292.91568896749317,83.30577340634848],[342.75097769917346,87.36089326031818,483.6879399646281,98.82899725622241,514.4378226407272,101.33112903714697,599,108.21199143468951]]},"glyphs":{"position":[-107.960693359375,-97,-107.960693359375,-97,-107.960693359375,-97,-107.960693359375,-97,-80,132.6960906982422,-80,132.6960906982422,-80,132.6960906982422,-80,132.6960906982422,235.99359130859375,111,235.99359130859375,111,235.99359130859375,111,235.99359130859375,111,599,108.21199035644531,599,108.21199035644531,599,108.21199035644531,599,108.21199035644531],"offset":[7.295975208282471,3.28157639503479,-1.2305911779403687,2.7359907627105713,2.4806315898895264,1.1157360076904297,1.2305911779403687,-2.7359907627105713,7.930744647979736,-1.0503766536712646,0.39389127492904663,2.974029302597046,2.696453094482422,-0.3571280837059021,-0.39389127492904663,-2.974029302597046,7.193761348724365,-3.4999706745147705,1.3124890327453613,2.6976606845855713,2.4458789825439453,-1.1899900436401367,-1.3124890327453613,-2.6976606845855713,0,0,-8.21695327758789,2.3412981033325195,-5.262606620788574,-0.4282206594944,-7.730339050292969,-3.6389365196228027],"index":[0,1,2,0,2,3,4,5,6,4,6,7,8,9,10,8,10,11,12,13,14,12,14,15]}},"hull":{"px":0.5,"title":"Déduction jointe","g":{"marker":[379,91],"u":[0.9968729974970433,0.07902042053330222],"trunk":null,"branches":[[546.9301250719078,104.3115343044805,491.5131837981782,99.91872798400193,286.6384312104507,83.67865613253572,379,91],[379,91,500,100.59146341463415,526.4,102.68414634146342,599,108.4390243902439]]},"glyphs":{"position":[546.9301147460938,104.31153106689453,546.9301147460938,104.31153106689453,546.9301147460938,104.31153106689453,546.9301147460938,104.31153106689453,546.9301147460938,104.31153106689453,546.9301147460938,104.31153106689453,546.9301147460938,104.31153106689453,546.9301147460938,104.31153106689453,599,108.43902587890625,599,108.43902587890625,599,108.43902587890625,599,108.43902587890625],"offset":[-7.974984169006348,-0.6321633458137512,0.2370612621307373,-2.990618944168091,-2.7114944458007812,-0.2149355411529541,-0.2370612621307373,2.990618944168091,-5.588469982147217,-0.44298848509788513,-1.0718451738357544,-1.740139126777649,-2.6935508251190186,-0.21351318061351776,-1.3326125144958496,1.5495418310165405,0,0,-8.212045669555664,2.3584556579589844,-5.263489246368408,-0.4172278344631195,-7.737922668457031,-3.6227824687957764],"index":[0,1,2,0,2,3,4,5,6,4,6,7,8,9,10,8,10,11]}},"padded":[-398.9553865331745,80.62782098278294,-338.3951460466693,-238.8331749058798,-68.74324177974044,-260.9910254445066,330.28463498326573,-235.21811050283526,511.3921942000004,180.25518643551337,490.54436583242887,321.71912897535805,-34.06113036295277,401.98025820473356,-373.3380951166243,376.3380951166243]};

test('géométrie des faisceaux, de leurs pointes et d’une enveloppe : les nombres de 9064ac0, au bit près', () => {
  const { s, ids } = fixture();
  const scene = buildScene(s, ids.plans.lobby, measure, P), index = buildIndex(scene, P), b = scene.bounds!;
  const camAt = (px: number): Camera => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, zoom: px / (P.baseFontPx * P.textScale), widthPx: 2560, heightPx: 1600 });
  const origin: Vec2 = { x: 13, y: -7 };
  const geo = (g: BundleGeometry) => ({
    marker: [g.marker.x, g.marker.y], u: [g.u.x, g.u.y], trunk: g.trunk ? [g.trunk[0].x, g.trunk[0].y, g.trunk[1].x, g.trunk[1].y] : null,
    branches: g.branches.map((x) => [x.p0.x, x.p0.y, x.b1.x, x.b1.y, x.b2.x, x.b2.y, x.p3.x, x.p3.y]),
  });
  const glyphs = (open: BundleGeometry) => {
    const m = newGlyphMeshes();
    appendBundleGlyphs(m, open, null, { end0: [1, 2, 3], end1: [4, 5, 6], fade: 'none', foldK: Number.NaN, conn: 7 }, P);
    return { position: [...m.position.view()], offset: [...m.offset.view()], index: [...m.index.view()] };
  };
  // A bundle of three members or more (a trunk), where every title reads; one ending on a closed group, from afar.
  const multi = computeVisible(scene, index, camAt(16), P).connections.find((vc) => vc.ends.length >= 3 && !isSimple(scene, vc))!;
  const a = bundleFor(scene, multi, P, origin);
  let hull: unknown = null;
  for (const px of [0.5, 1, 2, 3, 5]) {
    const vc = computeVisible(scene, index, camAt(px), P).connections.find((x) => x.ends.some((e) => scene.items[e.item].kind === 'group'));
    if (vc) { const g = bundleFor(scene, vc, P, origin); hull = { px, title: scene.titles[vc.conns[0]], g: geo(g), glyphs: glyphs(g) }; break; }
  }
  const grp = scene.items[scene.byId.get(ids.nodes.groupeComplexite)!];
  const now = {
    multi: { title: scene.titles[multi.conns[0]], g: geo(a), glyphs: glyphs(a) }, hull,
    padded: offsetPolygon(grp.hull!, grp.pad!).flatMap((q) => [q.x, q.y]),
  };
  const zeroed = (v: unknown) => JSON.parse(JSON.stringify(v));
  expect(zeroed(now)).toEqual(AT_9064AC0);
});
