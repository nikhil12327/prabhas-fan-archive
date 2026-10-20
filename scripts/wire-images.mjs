// Wires the per-movie image folders into the site.
// Usage: node wire-images.mjs
import fs from 'node:fs';
import path from 'node:path';

const SRC = String.raw`C:\Users\bonig\Downloads\Prabhas\Images`;
const HTML = 'index.html';

// Source folder name (lowercase) -> film slug used in index.html
const MAP = {
  'eeswar': 'eeswar',
  'raghavendra': 'raghavendra',
  'varsham': 'varsham',
  'adavi ramudu': 'adavi-ramudu',
  'chakram': 'chakram',
  'chatrapathi': 'chatrapathi',
  'pournami': 'pournami',
  'yogi': 'yogi',
  'munna': 'munna',
  'bujjigadu': 'bujjigadu',
  'billa': 'billa',
  'ek niranjan': 'ek-niranjan',
  'darling': 'darling',
  'mr. perfect': 'mr-perfect',
  'rebel': 'rebel',
  'mirchi': 'mirchi',
  'bahubali': 'baahubali-the-beginning',
  'bahubali 2': 'baahubali-2-the-conclusion',
  'saaho': 'saaho',
  'radheshyam': 'radhe-shyam',
  'adipurush': 'adipurush',
  'salaar': 'salaar-part-1-ceasefire',
  'kalki': 'kalki-2898-ad',
  'the raja saab': 'the-raja-saab',
};

const norm = s => s.toLowerCase().trim().replace(/\s+/g, ' ');
const srcDirs = fs.readdirSync(SRC, { withFileTypes: true }).filter(d => d.isDirectory());
const slugByDir = new Map(srcDirs.map(d => [norm(d.name), MAP[norm(d.name)]]));

let html = fs.readFileSync(HTML, 'utf8');
let totalFiles = 0;

for (const [key, slug] of Object.entries(MAP)) {
  const dirName = srcDirs.find(d => norm(d.name) === key)?.name;
  if (!dirName) { console.error(`!! source folder not found: ${key}`); continue; }
  const srcDir = path.join(SRC, dirName);
  const files = fs.readdirSync(srcDir)
    .filter(f => /\.jpe?g$/i.test(f))
    .sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0) || a.localeCompare(b));
  if (!files.length) { console.error(`!! no images in ${dirName}`); continue; }

  const destDir = path.join('images', slug);
  fs.mkdirSync(destDir, { recursive: true });
  for (const old of fs.readdirSync(destDir)) fs.rmSync(path.join(destDir, old));

  const rels = files.map((f, i) => {
    const name = i === 0 ? 'main.jpg' : `photo-${i + 1}.jpg`;
    fs.copyFileSync(path.join(srcDir, f), path.join(destDir, name));
    return `images/${slug}/${name}`;
  });
  totalFiles += rels.length;

  const before = html;
  html = html
    .replace(new RegExp(`"slug": "${slug}",[^\\n]*?"coverImage": "[^"]*"`),
      m => m.replace(/"coverImage": "[^"]*"/, `"coverImage": "${rels[0]}"`))
    .replace(new RegExp(`"slug": "${slug}",[^\\n]*?"images": \\[[^\\]]*\\]`),
      m => m.replace(/"images": \[[^\]]*\]/, `"images": [${rels.map(r => `"${r}"`).join(', ')}]`));
  if (html === before) { console.error(`!! movie entry not updated: ${slug}`); continue; }
  console.log(`${slug.padEnd(28)} <- ${dirName.padEnd(16)} ${rels.length} image(s)`);
}

fs.writeFileSync(HTML, html);
const unmapped = srcDirs.filter(d => !MAP[norm(d.name)]);
if (unmapped.length) console.error('!! folders without a film match:', unmapped.map(d => d.name).join(', '));
console.log(`\nDone. ${Object.keys(MAP).length} films wired, ${totalFiles} files copied. index.html is now ${(fs.statSync(HTML).size / 1e6).toFixed(2)} MB.`);
