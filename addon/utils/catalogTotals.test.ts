import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogTotalOf, listTotal, sourceCountApplies, sumCatalogTotals, withCatalogTotal } from './catalogTotals.ts';

test('a total rides with its own page only', () => {
  const page = [{ id: 'a' }, { id: 'b' }];
  assert.equal(withCatalogTotal(page, 90), page);
  assert.equal(catalogTotalOf(page), 90);
  assert.equal(catalogTotalOf([{ id: 'a' }, { id: 'b' }]), undefined);
  assert.equal(catalogTotalOf(null), undefined);
});

test('unusable totals are ignored', () => {
  for (const bad of [undefined, null, 'x', -1, Number.NaN]) {
    const page: any[] = [];
    withCatalogTotal(page, bad);
    assert.equal(catalogTotalOf(page), undefined, String(bad));
  }
  const page: any[] = [];
  withCatalogTotal(page, '277.9');
  assert.equal(catalogTotalOf(page), 277);
});

test('a merged catalog knows its size only when every part does', () => {
  assert.equal(sumCatalogTotals([90, 200]), 290);
  assert.equal(sumCatalogTotals([90, undefined]), undefined);
  assert.equal(sumCatalogTotals([]), undefined);
});

test('a source count describes a list only when no filter narrows it', () => {
  assert.equal(sourceCountApplies('all', undefined), true);
  assert.equal(sourceCountApplies('all', 'Movie,Series'), true);
  assert.equal(sourceCountApplies('all', 'Movie'), false); // a merged films+shows folder asked for films only
  assert.equal(sourceCountApplies('movie', 'Movie'), true);
  assert.equal(sourceCountApplies('series', 'Movie,Series'), true);
  assert.equal(sourceCountApplies('series', 'Movie'), false);
  assert.equal(sourceCountApplies('all', 'Movie,Series', true), false); // rating or played filter
});

test('without a known size the lookahead is unchanged', () => {
  assert.equal(listTotal({ startIndex: 0, served: 50, pageLimit: 50, hasMore: true }), 100);
  assert.equal(listTotal({ startIndex: 150, served: 50, pageLimit: 50, hasMore: true }), 250);
  assert.equal(listTotal({ startIndex: 250, served: 27, pageLimit: 50, hasMore: false }), 277);
});

test('a known size is reported up front', () => {
  // Netflix: 90 films + 200 shows at the source, 277 left after filters.
  assert.equal(listTotal({ startIndex: 0, served: 50, pageLimit: 50, hasMore: true, known: 290 }), 290);
  assert.equal(listTotal({ startIndex: 200, served: 50, pageLimit: 50, hasMore: true, known: 290 }), 290);
  // The end settles on what was actually served, below the source's count.
  assert.equal(listTotal({ startIndex: 250, served: 27, pageLimit: 50, hasMore: false, known: 290 }), 277);
});

test('a known size that is already behind falls back to the lookahead', () => {
  assert.equal(listTotal({ startIndex: 300, served: 50, pageLimit: 50, hasMore: true, known: 290 }), 400);
});

test('past the end the known size wins over the index asked for', () => {
  assert.equal(listTotal({ startIndex: 450, served: 0, pageLimit: 50, hasMore: false, known: 277 }), 277);
  assert.equal(listTotal({ startIndex: 450, served: 0, pageLimit: 50, hasMore: false }), 450);
  assert.equal(listTotal({ startIndex: 0, served: 0, pageLimit: 50, hasMore: false, known: 290 }), 0);
});
