import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { citationMeta } from '../src/html.ts';

/**
 * Pages written after the real ones, their <meta> tags of the Highwire standard as those sites write them, the rest cut
 * down (plan 5b, D3): an OpenReview forum (React, `charSet`, self-closing tags), a PMLR page (Jekyll, its PDF in http), a
 * NeurIPS proceedings page, an ACL Anthology page (Hugo, minified: unquoted values, `content` before `name`, a DOI).
 */
const DATA = join(fileURLToPath(new URL('.', import.meta.url)), 'data');
const page = (name: string) => readFileSync(join(DATA, name), 'utf8');

test('citationMeta : les pages d’OpenReview, de PMLR, des actes de NeurIPS et de l’ACL Anthology', () => {
  expect(citationMeta(page('openreview.html'), 'https://openreview.net/forum?id=YicbFdNTTy')).toEqual({ pdfUrl: 'https://openreview.net/pdf?id=YicbFdNTTy' });
  // PMLR's link is in http: asked in https, the only scheme the open web takes (D3).
  expect(citationMeta(page('pmlr.html'), 'https://proceedings.mlr.press/v139/radford21a.html'))
    .toEqual({ pdfUrl: 'https://proceedings.mlr.press/v139/radford21a/radford21a.pdf' });
  expect(citationMeta(page('neurips.html'), 'https://proceedings.neurips.cc/paper_files/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html'))
    .toEqual({ pdfUrl: 'https://proceedings.neurips.cc/paper_files/paper/2017/file/3f5ee243547dee91fbd053c1c4a845aa-Paper.pdf' });
  expect(citationMeta(page('acl.html'), 'https://aclanthology.org/N19-1423/')).toEqual({ doi: '10.18653/v1/N19-1423', pdfUrl: 'https://aclanthology.org/N19-1423.pdf' });
});

test('citationMeta : une page sans balise n’en donne rien', () => {
  expect(citationMeta('', 'https://example.org/')).toEqual({});
  expect(citationMeta('<!DOCTYPE html><html><head><title>Rien</title><meta name="description" content="10.1000/x"></head><body>citation_doi 10.1000/x</body></html>', 'https://example.org/')).toEqual({});
  // An empty value, a tag without content, a name that only begins so: nothing.
  expect(citationMeta('<meta name="citation_doi" content="  "><meta name="citation_pdf_url"><meta name="citation_doi_x" content="10.1/x">', 'https://example.org/')).toEqual({});
});

test('citationMeta : les attributs dans les deux ordres, entre guillemets, apostrophes ou sans, le nom sans casse, les entités décodées, l’adresse du PDF relative à la page', () => {
  const base = 'https://editeur.example/revue/article/42?lang=fr';
  expect(citationMeta('<META CONTENT="10.1000/abc" NAME="Citation_DOI">', base)).toEqual({ doi: '10.1000/abc' });
  expect(citationMeta(`<meta name='citation_arxiv_id' content='1706.03762v7'/>`, base)).toEqual({ arxiv: '1706.03762v7' });
  expect(citationMeta('<meta\nname=citation_doi\tcontent=10.1000/a&amp;b>', base)).toEqual({ doi: '10.1000/a&b' });
  expect(citationMeta('<meta name="citation_doi" content="10.1000/&lt;x&gt;&#38;&#x41;&quot;">', base)).toEqual({ doi: '10.1000/<x>&A"' });
  expect(citationMeta('<meta name="citation_pdf_url" content="../pdf/42.pdf?dl=1&amp;v=2">', base)).toEqual({ pdfUrl: 'https://editeur.example/revue/pdf/42.pdf?dl=1&v=2' });
  expect(citationMeta('<meta name="citation_pdf_url" content="//cdn.editeur.example/42.pdf">', base)).toEqual({ pdfUrl: 'https://cdn.editeur.example/42.pdf' });
  // The first of each, blanks around dropped; the other tags ignored.
  expect(citationMeta([
    '<meta property="og:title" content="10.9999/og">', '<meta name="citation_doi" content=" 10.1000/premier ">', '<meta name="citation_doi" content="10.1000/second">',
    '<meta name="citation_pdf_url" content="https://editeur.example/a.pdf"><meta name="citation_pdf_url" content="https://editeur.example/b.pdf">',
  ].join('\n'), base)).toEqual({ doi: '10.1000/premier', pdfUrl: 'https://editeur.example/a.pdf' });
  // A PDF's address that is no http(s) address, or none at all, is dropped: never followed.
  for (const content of ['javascript:alert(1)', 'data:application/pdf;base64,JVBERi0=', 'file:///C:/x.pdf', 'http://[zz']) {
    expect(citationMeta(`<meta name="citation_pdf_url" content="${content}">`, base), content).toEqual({});
  }
  // Without the page's address, only an absolute one is taken.
  expect(citationMeta('<meta name="citation_pdf_url" content="/a.pdf"><meta name="citation_doi" content="10.1000/x">')).toEqual({ doi: '10.1000/x' });
  expect(citationMeta('<meta name="citation_pdf_url" content="https://editeur.example/a.pdf">')).toEqual({ pdfUrl: 'https://editeur.example/a.pdf' });
  // A value too long for an identifier is none.
  expect(citationMeta(`<meta name="citation_doi" content="10.1000/${'x'.repeat(2000)}">`, base)).toEqual({});
});

test('citationMeta : une page énorme ou piégée est lue en temps linéaire', () => {
  const MB = 2 ** 20;
  const cases = [
    // Tags that never close, attributes without end, quotes that never close, entities without end.
    '<meta '.repeat(Math.ceil(8 * MB / 6)),
    `<meta ${'a'.repeat(8 * MB)}`,
    `<meta ${'a '.repeat(4 * MB)}>`,
    `<meta name="citation_doi" content="${'x'.repeat(8 * MB)}`,
    `<meta name=${'='.repeat(8 * MB)}>`,
    `<meta name="citation_doi" content="${'&amp'.repeat(2 * MB)}">`,
  ];
  for (const html of cases) {
    const t0 = performance.now();
    expect(citationMeta(html, 'https://example.org/')).toEqual({});
    expect(performance.now() - t0, html.slice(0, 20)).toBeLessThan(2000);
  }
  // Its tags at the end of 8 MB of others: found all the same, as fast.
  const t0 = performance.now();
  const big = `${'<meta name="citation_author" content="Quelqu’un">'.repeat(160_000)}<meta name="citation_doi" content="10.1000/fin">`;
  expect(citationMeta(big, 'https://example.org/')).toEqual({ doi: '10.1000/fin' });
  expect(performance.now() - t0).toBeLessThan(2000);
});
