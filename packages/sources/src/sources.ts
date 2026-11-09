/**
 * Where a publication's metadata and an arXiv article's PDF come from (plan 4c, D5, D6), in this one place, as
 * LATEX_SOURCES is for LaTeX: the hosts a request may reach, and the addresses asked of them. Internet sources for now;
 * plans 5 and 9 point them at Cirrus's own server. No other module of this package, the app or the server names one of
 * these hosts (a test checks it): the links a user pastes, which parseIdentifier reads, are listed here too
 * (IDENTIFIER_LINKS).
 */

export interface PublicationSources {
  /**
   * The only hosts a request reaches, in HTTPS on the default port (fetch.ts): doi.org, Crossref and DataCite where it
   * redirects to, arXiv for its PDFs. A redirect to any other is refused before it is followed. data.crosscite.org is
   * DataCite's content negotiation, where doi.org sends a DataCite DOI (arXiv's among them) and data.datacite.org
   * redirects (ruling of task 4).
   */
  hosts: readonly string[];
  /** A DOI's record, which doi.org gives in the format the request's Accept asks for (content negotiation, D5). */
  doiUrl(doi: string): string;
  /** An arXiv article's PDF (D6), `id` as parseIdentifier gives it (new or old style, its version if any). */
  arxivPdfUrl(id: string): string;
}

/**
 * A DOI in a path: every character a URL would read otherwise escaped (« ? », « # », « % », « ; », « < »…), its « / »
 * kept, which doi.org reads as part of the DOI.
 */
const pathOf = (doi: string) => encodeURIComponent(doi).replace(/%2F/gi, '/');

export const PUBLICATION_SOURCES: PublicationSources = {
  hosts: ['doi.org', 'api.crossref.org', 'data.crossref.org', 'api.datacite.org', 'data.datacite.org', 'data.crosscite.org', 'arxiv.org'],
  doiUrl: (doi) => `https://doi.org/${pathOf(doi)}`,
  arxivPdfUrl: (id) => `https://arxiv.org/pdf/${id}`,
};

/**
 * The hosts of the links a user pastes as an identifier (parseIdentifier): a DOI's resolver, arXiv's pages. Read as
 * identifiers only, never fetched: they are not PUBLICATION_SOURCES, which plans 5 and 9 change.
 */
export const IDENTIFIER_LINKS: { doi: readonly string[]; arxiv: readonly string[] } = {
  doi: ['doi.org', 'dx.doi.org', 'www.doi.org'],
  arxiv: ['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'],
};
