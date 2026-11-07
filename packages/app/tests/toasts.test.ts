import { DEFAULT_PARAMS as P } from '@cirrus/view';
import { expect, test } from 'vitest';
import { type Toast, toastClicked, toastMsFor, toastsEscaped } from '../src/renderer/ui/Toasts.tsx';

test('la notification d’un import de .bib (revue de la tâche 6, I1) : elle reste bibNoticeMs, les autres toastMs ; un clic sur elle ou Échap la ferme plus tôt, pas les autres', () => {
  expect(toastMsFor(true, P)).toBe(20_000);
  expect(toastMsFor(true, { ...P, bibNoticeMs: 45_000 })).toBe(45_000);
  expect(toastMsFor(false, { ...P, bibNoticeMs: 45_000 })).toBe(P.toastMs);
  const shown: Toast[] = [{ id: 1, text: 'Action refusée.' }, { id: 2, text: '7 publications importées…\n1 doublon écarté :', closable: true }];
  // A click on the import's notice closes it; on another, nothing (it takes no clicks: pointer-events none).
  expect(toastClicked(shown, 2)).toEqual([shown[0]]);
  expect(toastClicked(shown, 1)).toBe(shown);
  // Escape closes the closable ones only, and leaves the list as it is when there is none (no render).
  expect(toastsEscaped(shown)).toEqual([shown[0]]);
  const plain = [shown[0]];
  expect(toastsEscaped(plain)).toBe(plain);
});
