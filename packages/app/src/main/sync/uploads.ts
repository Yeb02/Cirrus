import { openAsBlob } from 'node:fs';
import { MAX_HASHES_PER_REQUEST, type Unit } from '@cirrus/core';
import { filePath } from '@cirrus/store';
import { type Connection, JSON_BODY, json, ok, reasonOf, Refusal } from './connection.ts';
import { filesToSend, hasBlob, type TransferRates } from './downloads.ts';

// The files this PC's writes add, sent to the server before them (plan 5a, D6), each once; those of the writes received
// come down by downloads.ts. Each sent is measured for the throughput (plan 5b, D8: TransferRates).

export class Uploads {
  /** Where the base keeps its files (files/<2 hex>/<hash>). */
  private readonly storeDir: string;
  /** The files the server is known to hold: each sent once. The server never removes one. */
  private readonly onServer = new Set<string>();
  private readonly rates: TransferRates;

  constructor(storeDir: string, rates: TransferRates) {
    this.storeDir = storeDir;
    this.rates = rates;
  }

  /**
   * The files the batch adds that the server lacks, each sent once (D6), before the writes: the server refuses a write
   * whose file it does not hold. One this PC lacks too, or that the server will not take (its bytes no longer those of
   * their hash, too large), is left: the server then refuses the write (« Fichier manquant au serveur. »), dropped.
   */
  async send(conn: Connection, batch: Unit[]): Promise<void> {
    const hashes = filesToSend(batch).filter((h) => !this.onServer.has(h));
    for (let i = 0; i < hashes.length; i += MAX_HASHES_PER_REQUEST) {
      const chunk = hashes.slice(i, i + MAX_HASHES_PER_REQUEST);
      const body = await json(await conn.request('/files/missing', { method: 'POST', headers: JSON_BODY, body: JSON.stringify({ hashes: chunk }) }));
      const missing = (body as { missing?: unknown } | null)?.missing;
      if (!Array.isArray(missing)) throw new Refusal('Réponse du serveur illisible à /files/missing : mets à jour Cirrus, ou le serveur.');
      const absent = new Set(missing);
      for (const hash of chunk) {
        if (absent.has(hash)) {
          if (!hasBlob(this.storeDir, hash)) continue;
          const file = await openAsBlob(filePath(this.storeDir, { name: '', hash, size: 0 }));
          const since = this.rates.clock();
          const res = await conn.request(`/files/${hash}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file as unknown as Blob });
          if (res.status === 400 || res.status === 413) {
            console.warn(`Fichier ${hash} refusé par le serveur : ${await reasonOf(res)}`);
            continue;
          }
          await ok(res);
          await res.body?.cancel();
          // Its bytes all taken by the server, kept: one transfer measured.
          this.rates.measured(file.size, since);
        }
        this.onServer.add(hash);
      }
    }
  }
}
