import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { devServerUrl, externalUrlAllowed, navigationAllowed } from '../src/main/navigation.ts';

// The window's two addresses: the dev server's (ELECTRON_RENDERER_URL), and the built app's page, a file: URL.
const DEV = 'http://localhost:5173/';
const BUILT = pathToFileURL('C:\\Users\\alpha\\Desktop\\Cirrus\\packages\\app\\out\\renderer\\index.html').href;

test('navigationAllowed : l’adresse de l’app elle-même, avec ou sans fragment (Review Focus 2)', () => {
  expect(navigationAllowed(DEV, DEV)).toBe(true);
  expect(navigationAllowed('http://localhost:5173/#plan', DEV)).toBe(true);
  expect(navigationAllowed(BUILT, BUILT)).toBe(true);
  expect(navigationAllowed(`${BUILT}#plan`, BUILT)).toBe(true);
  // The same page as Chromium writes it from loadFile (backslashes) is the same address.
  expect(navigationAllowed('file:///C:\\Users\\alpha\\Desktop\\Cirrus\\packages\\app\\out\\renderer\\index.html', BUILT)).toBe(true);
});

test('navigationAllowed : ni un PDF en file:, ni une page https:, ni about:blank, ni une autre page de l’app (Review Focus 2)', () => {
  const pdf = pathToFileURL('C:\\Users\\alpha\\Documents\\article.pdf').href;
  for (const app of [DEV, BUILT]) {
    expect(navigationAllowed(pdf, app), app).toBe(false);
    expect(navigationAllowed('https://example.org/', app), app).toBe(false);
    expect(navigationAllowed('about:blank', app), app).toBe(false);
    expect(navigationAllowed('pas une adresse', app), app).toBe(false);
  }
  expect(navigationAllowed('http://localhost:5173/autre.html', DEV)).toBe(false);
  expect(navigationAllowed('http://localhost:5173/?x=1', DEV)).toBe(false);
  expect(navigationAllowed('http://localhost:5174/', DEV)).toBe(false);
  expect(navigationAllowed(pathToFileURL('C:\\Users\\alpha\\Desktop\\Cirrus\\packages\\app\\out\\renderer\\autre.html').href, BUILT)).toBe(false);
  // Served by the app's own protocol, a blob is not the app either.
  expect(navigationAllowed(`cirrus-file://blob/${'0'.repeat(64)}/a.svg`, BUILT)).toBe(false);
});

test('externalUrlAllowed : un lien d’un PDF vers http:, https: ou mailto: seulement (plan 4a, tâche 6)', () => {
  for (const url of ['https://example.org/kolmogorov', 'http://example.org/', 'HTTPS://EXAMPLE.ORG/a?b=c#d', 'mailto:auteur@example.org', 'mailto:a@b.c?subject=Cirrus']) {
    expect(externalUrlAllowed(url), url).toBe(true);
  }
  for (const url of [
    'file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'cirrus:noeud/0193', `cirrus-file://blob/${'0'.repeat(64)}/a.pdf`, 'ftp://example.org/',
    'tel:+33123456789', 'data:text/html,<p>', 'about:blank', 'pas une adresse', '', 'https:',
  ]) {
    expect(externalUrlAllowed(url), url).toBe(false);
  }
});

test('devServerUrl : l’adresse du serveur de développement d’electron-vite, jamais dans l’app empaquetée (plan 9, tâche 3, M5)', () => {
  expect(devServerUrl({ ELECTRON_RENDERER_URL: DEV }, false)).toBe(DEV);
  expect(devServerUrl({ ELECTRON_RENDERER_URL: DEV }, true)).toBeUndefined();
  expect(devServerUrl({ ELECTRON_RENDERER_URL: '' }, false)).toBeUndefined();
  expect(devServerUrl({}, false)).toBeUndefined();
});
