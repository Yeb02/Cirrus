// Writes the test base's three-page PDF (plan 4a, task 6), without any dependency: npm run pdf -w packages/fixtures
// The file is kept in assets/ with the others; the fixture's test checks it is still this script's output.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chapterPdf } from '../src/pdf.ts';

const out = fileURLToPath(new URL('../assets/Li_Vitányi_chapitre_1.pdf', import.meta.url));
const bytes = chapterPdf();
writeFileSync(out, bytes);
console.log(`${out} : ${bytes.length} octets.`);
