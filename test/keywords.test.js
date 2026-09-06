import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleToKeyword, WIKI_SOURCES } from '../src/keywords.js';
import { NICHES } from '../src/config.js';

test('Wikipedia titles become domain-shaped keywords', () => {
  assert.equal(titleToKeyword('Gothic Lolita'), 'gothiclolita');
  assert.equal(titleToKeyword('Visual Kei'), 'visualkei');
  assert.equal(titleToKeyword('Jirai-kei'), 'jiraikei');
  assert.equal(titleToKeyword('Aristocrat (fashion)'), 'aristocrat');
  assert.equal(titleToKeyword('Barbiecore'), 'barbiecore');
});

test('Wikipedia noise is rejected before it costs a query', () => {
  // Every one of these came back from a real harvest of "Japanese street
  // fashion" and "Category:Fashion aesthetics".
  for (const noise of [
    'Amsterdam Fashion Week', 'History of Italian fashion', 'Atlanta Fashion Week',
    '2000s in Japanese fashion', '21st century in fashion', 'List of subcultures',
    'Bunka Fashion College', 'Category:Japanese fashion',
  ]) {
    assert.equal(titleToKeyword(noise), null, `should reject "${noise}"`);
  }
});

test('terms too generic to identify a brand are rejected', () => {
  for (const generic of ['Fashion', 'Clothing', 'Aesthetics', 'Pottery', 'Jewellery', 'Androgyny']) {
    assert.equal(titleToKeyword(generic), null, `"${generic}" is too generic`);
  }
});

test('harvest sources cover the niches that need vocabulary most', () => {
  const niches = new Set(WIKI_SOURCES.map((s) => s.niche));
  assert.ok(niches.has('alt_fashion'), 'alt fashion is the deepest vocabulary');
  assert.ok(WIKI_SOURCES.filter((s) => s.niche === 'alt_fashion').length >= 5);
  for (const s of WIKI_SOURCES) {
    assert.ok(['links', 'category'].includes(s.kind));
    assert.ok(Object.keys(NICHES).includes(s.niche), `${s.niche} must be a real niche`);
  }
});

test('the alt-fashion classifier covers every style Lucia named', () => {
  const kw = NICHES.alt_fashion.keywords;
  for (const must of [
    'emo', 'goth', 'cutecore', 'cute', 'kawaii', 'harajuku', 'lolita', 'y2k',
    'gyaru', 'decora', 'visual kei', 'fairy kei', 'jirai kei', 'menhera',
    'japanese street', 'sanrio',
  ]) {
    assert.ok(kw.includes(must), `alt_fashion classifier is missing "${must}"`);
  }
});

test('person names harvested from citations are rejected', () => {
  // All of these came back from a real harvest and were wrongly accepted.
  for (const person of [
    'Vivienne Westwood', 'Lewis Carroll', 'Sumire Uesaka', 'Sonia Leong',
    'Andrew Bolton', 'Paul Morley', 'Garry Crawford',
  ]) {
    assert.equal(titleToKeyword(person), null, `should reject person "${person}"`);
  }
});

test('cultural-studies noise that flooded the first harvest is rejected', () => {
  for (const noise of [
    'Cultural astronomy', 'Transculturation', 'Interculturalism', 'Consumerism',
    'Cultural conflict', 'Participatory culture', 'Cultural literacy',
    'Fashion in South Korea', 'Chinese clothing', 'Clothing in ancient Egypt',
    'I.B. Tauris',
  ]) {
    assert.equal(titleToKeyword(noise), null, `should reject "${noise}"`);
  }
});

test('real style and garment vocabulary survives the filter', () => {
  // The good half of the same harvest - these are the keywords worth having.
  for (const [title, expected] of [
    ['Bondage pants', 'bondagepants'],
    ['Bovver boot', 'bovverboot'],
    ['Devilock', 'devilock'],
    ['Ganguro', 'ganguro'],
    ['Petticoat', 'petticoat'],
    ['Barbiecore', 'barbiecore'],
    ['VSCO girl', 'vscogirl'],
    ['Juggalo', 'juggalo'],
  ]) {
    assert.equal(titleToKeyword(title), expected, `should keep "${title}"`);
  }
});

test('ambiguous common words are rejected before they cost a validation query', () => {
  // "camp" passed validation with 4548 certs and 81 domains - all campgrounds.
  // Productive is not the same as distinctive.
  for (const word of ['Camp', 'Boyfriend', 'Cutoff', 'Vintage', 'Classic', 'Geek', 'Mod']) {
    assert.equal(titleToKeyword(word), null, `"${word}" is too ambiguous`);
  }
  // ...but distinctive compounds using the same roots survive.
  assert.equal(titleToKeyword('Bovver boot'), 'bovverboot');
  assert.equal(titleToKeyword('Soft grunge'), 'softgrunge');
});

test('generic style adjectives are rejected like other ambiguous words', () => {
  // "chic" survived validation with 1267 certs and 57 plausible domains, all
  // of them chic salons and chic realty. Productive is not distinctive.
  for (const w of ['Chic', 'Glam', 'Boho', 'Preppy', 'Edgy', 'Luxe', 'Trendy']) {
    assert.equal(titleToKeyword(w), null, `"${w}" identifies nothing`);
  }
  // Compounds using them are still fine.
  assert.equal(titleToKeyword('Boho-chic'), 'bohochic');
});
