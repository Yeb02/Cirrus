import { expect, test } from 'vitest';
import { isAddress, MAX_ADDRESS_CHARS, MAX_IDENTIFIER_CHARS, parseIdentifier } from '../src/identifier.ts';

/** Plan 5b, D4: the DOI an address of a publisher holds, read without any request. */
test('parseIdentifier : les adresses de l’ACM, de Springer, de Wiley et de Taylor & Francis donnent leur DOI (D4)', () => {
  const cases: [string, string][] = [
    // ACM: the DOI after /doi/, /doi/pdf/, /doi/abs/ (« pdf » placed before the DOI: nothing is trimmed).
    ['https://dl.acm.org/doi/10.1145/3292500.3330701', '10.1145/3292500.3330701'],
    ['https://dl.acm.org/doi/pdf/10.1145/3292500.3330701', '10.1145/3292500.3330701'],
    ['https://dl.acm.org/doi/abs/10.1145/3292500.3330701', '10.1145/3292500.3330701'],
    ['https://dl.acm.org/doi/fullHtml/10.1145/3292500.3330701', '10.1145/3292500.3330701'],
    // Springer: an article, a chapter, a PDF (« .pdf » trimmed).
    ['https://link.springer.com/article/10.1007/s10994-021-05946-3', '10.1007/s10994-021-05946-3'],
    ['https://link.springer.com/chapter/10.1007/978-3-030-58452-8_13', '10.1007/978-3-030-58452-8_13'],
    ['https://link.springer.com/content/pdf/10.1007/s10994-021-05946-3.pdf', '10.1007/s10994-021-05946-3'],
    // Wiley: /doi/full/, /doi/epdf/, /doi/pdfdirect/, and its older addresses, where « full » or « abstract » follow the DOI.
    ['https://onlinelibrary.wiley.com/doi/full/10.1111/j.1467-9868.2005.00503.x', '10.1111/j.1467-9868.2005.00503.x'],
    ['https://onlinelibrary.wiley.com/doi/epdf/10.1002/anie.201915678', '10.1002/anie.201915678'],
    ['https://onlinelibrary.wiley.com/doi/pdfdirect/10.1002/anie.201915678?download=true', '10.1002/anie.201915678'],
    ['https://onlinelibrary.wiley.com/doi/10.1111/j.1365-2486.2009.02040.x/full', '10.1111/j.1365-2486.2009.02040.x'],
    ['http://onlinelibrary.wiley.com/doi/10.1111/j.1365-2486.2009.02040.x/abstract', '10.1111/j.1365-2486.2009.02040.x'],
    // Taylor & Francis: /doi/full/, /doi/abs/, /doi/pdf/, their query ignored.
    ['https://www.tandfonline.com/doi/full/10.1080/01621459.2017.1285773', '10.1080/01621459.2017.1285773'],
    ['https://www.tandfonline.com/doi/abs/10.1080/01621459.2017.1285773?journalCode=uasa20', '10.1080/01621459.2017.1285773'],
    ['https://www.tandfonline.com/doi/pdf/10.1080/01621459.2017.1285773?download=true#page=2', '10.1080/01621459.2017.1285773'],
    // One last segment of the list, placed after the DOI's suffix, and a trailing « / ».
    ['https://example.org/10.1145/123.456/abs', '10.1145/123.456'],
    ['https://example.org/10.1145/123.456/abstract/', '10.1145/123.456'],
    ['https://example.org/10.1145/123.456/pdf', '10.1145/123.456'],
    ['https://example.org/10.1145/123.456/epdf', '10.1145/123.456'],
    ['https://example.org/10.1145/123.456/fulltext', '10.1145/123.456'],
    ['https://example.org/10.1145/123.456/Full', '10.1145/123.456'],
    // One only; and « .pdf » before it.
    ['https://example.org/10.1145/123/abs/pdf', '10.1145/123/abs'],
    ['https://example.org/10.1145/123/full.pdf', '10.1145/123'],
    ['https://example.org/10.1000/xyz.PDF', '10.1000/xyz'],
    // A segment that is the suffix itself is kept: it does not follow the suffix.
    ['https://example.org/10.1000/abs', '10.1000/abs'],
    ['https://example.org/doi/pdf/10.1000/pdf', '10.1000/pdf'],
    // The path decoded: an escaped « / », a character a path escapes.
    ['https://example.org/doi/10.1000%2Fabc', '10.1000/abc'],
    ['https://example.org/doi/10.1002/(SICI)1097-4636(199706)35%3A4%3C477%3A%3AAID-JBM8%3E3.0.CO%3B2-C', '10.1002/(SICI)1097-4636(199706)35:4<477::AID-JBM8>3.0.CO;2-C'],
  ];
  for (const [text, doi] of cases) expect(parseIdentifier(text), text).toEqual({ doi });
  // arXiv's own DOI in a publisher's address is its article, as everywhere (D6 of plan 4c).
  expect(parseIdentifier('https://example.org/doi/10.48550/arXiv.1706.03762')).toEqual({ arxiv: '1706.03762' });
  // The resolver's links keep their whole path: a DOI may end so there.
  expect(parseIdentifier('https://doi.org/10.1000/x/abstract')).toEqual({ doi: '10.1000/x/abstract' });
});

test('parseIdentifier : une adresse sans DOI dans son chemin n’en donne aucun (D4)', () => {
  for (const text of [
    'https://dl.acm.org/', 'https://openreview.net/forum?id=YicbFdNTTy', 'https://proceedings.mlr.press/v139/radford21a.html',
    'https://proceedings.neurips.cc/paper_files/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html',
    // In the query or the fragment, not the path.
    'https://example.org/lien?doi=10.1000/x', 'https://example.org/#10.1000/x',
    // Not at a segment's start; a registrant of 3 or 10 digits; no suffix.
    'https://example.org/a10.1000/x', 'https://example.org/10.123/x', 'https://example.org/10.1234567890/x', 'https://example.org/10.1000/',
    // A blank, a control character, a segment « .. » (decoded, or resolved away by the address itself).
    'https://example.org/10.1000/a%20b', 'https://example.org/10.1000/a%00b', 'https://example.org/10.1000/a/%2e%2e%2Fb', 'https://example.org/10.1000/../x',
    // Another scheme than http(s).
    'ftp://example.org/10.1000/x', 'file:///C:/10.1000/x',
    // A path that is no UTF-8 once decoded.
    'https://example.org/10.1000/%E0%A4%A',
    // A DOI of more than MAX_IDENTIFIER_CHARS, though the address is within MAX_ADDRESS_CHARS.
    `https://example.org/10.1000/${'x'.repeat(MAX_IDENTIFIER_CHARS)}`,
  ]) {
    expect(parseIdentifier(text), text).toBeNull();
  }
});

/** Plan 5b, task 4 (D3, D5): what the interface pre-checks before asking the main process for an address of the open web. */
test('isAddress : un schéma, « // », puis une adresse que la plateforme lit ; un identifiant ou un mot n’en est pas une', () => {
  for (const text of [
    'https://openreview.net/forum?id=YicbFdNTTy', '  https://proceedings.mlr.press/v139/radford21a.html  ', 'HTTPS://EXAMPLE.ORG/a.pdf',
    // Any scheme is an address: the main process refuses what is not https, in French (D3).
    'http://example.org/a.pdf', 'ftp://example.org/a.pdf',
  ]) expect(isAddress(text), text).toBe(true);
  for (const text of [
    '', '   ', 'bonjour', '10.1007/978-0-387-49820-1', 'doi:10.1007/978-0-387-49820-1', 'arXiv:1706.03762', 'openreview.net/forum?id=x', 'mailto:moi@example.org',
    'https://', 'https:///', '://example.org', '1http://example.org', `https://example.org/${'x'.repeat(MAX_ADDRESS_CHARS)}`,
  ]) expect(isAddress(text), text).toBe(false);
});

/** `head`, then « x » up to `n` characters. */
const padded = (head: string, n: number) => `${head}${'x'.repeat(n - head.length)}`;

// Final review of plan 5b, M1: a signed PDF link may pass 1 000 characters. An address has its own bound, 2 048, as
// `citation_pdf_url` (html.ts); an identifier keeps 1 000, bare or held by an address.
test('MAX_ADDRESS_CHARS : une adresse de 2 048 caractères en est une, pas au-delà ; un identifiant garde ses 1 000 caractères, seul ou dans une adresse', () => {
  expect([MAX_IDENTIFIER_CHARS, MAX_ADDRESS_CHARS]).toEqual([1000, 2048]);
  const signed = 'https://cdn.example.org/article.pdf?Expires=1762700000&Signature=';
  expect(isAddress(padded(signed, MAX_IDENTIFIER_CHARS + 300))).toBe(true);
  expect(isAddress(padded(signed, MAX_ADDRESS_CHARS))).toBe(true);
  expect(isAddress(padded(signed, MAX_ADDRESS_CHARS + 1))).toBe(false);
  // A publisher's address longer than MAX_IDENTIFIER_CHARS gives the DOI of its path; past MAX_ADDRESS_CHARS, none.
  const springer = 'https://link.springer.com/content/pdf/10.1007/s10994-021-05946-3.pdf?token=';
  expect(parseIdentifier(padded(springer, 1500))).toEqual({ doi: '10.1007/s10994-021-05946-3' });
  expect(parseIdentifier(padded(springer, MAX_ADDRESS_CHARS))).toEqual({ doi: '10.1007/s10994-021-05946-3' });
  expect(parseIdentifier(padded(springer, MAX_ADDRESS_CHARS + 1))).toBeNull();
  // A DOI of more than MAX_IDENTIFIER_CHARS is none, bare or in a resolver's link; a text that is no address neither.
  expect(parseIdentifier(padded('10.1234/', MAX_IDENTIFIER_CHARS))).toEqual({ doi: padded('10.1234/', MAX_IDENTIFIER_CHARS) });
  expect(parseIdentifier(padded('10.1234/', MAX_IDENTIFIER_CHARS + 1))).toBeNull();
  expect(parseIdentifier(padded('https://doi.org/10.1234/', MAX_IDENTIFIER_CHARS + 30))).toBeNull();
  expect(parseIdentifier(padded('arXiv:', MAX_IDENTIFIER_CHARS + 1))).toBeNull();
});
