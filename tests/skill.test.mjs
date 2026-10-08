import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../scripts/index.js', import.meta.url), 'utf8');
function load(fetch) {
  const window = {};
  runInNewContext(source, { window, fetch, AbortController, setTimeout, clearTimeout });
  return async input => JSON.parse(await window.ai_edge_gallery_get_result(JSON.stringify(input)));
}
function response(value, status = 200, type = 'application/json') {
  return { ok: status >= 200 && status < 300, status,
    headers: { get: key => key === 'Content-Type' ? type : null },
    text: async () => typeof value === 'string' ? value : JSON.stringify(value) };
}
function mock(result, requests) {
  return async (url, options) => {
    assert.equal(url, 'https://mcp.vkusvill.ru/mcp');
    assert.equal(options.credentials, 'omit');
    const p = JSON.parse(options.body);
    requests.push(p);
    if (p.method === 'initialize') return response({ jsonrpc: '2.0', id: 1, result: {
      protocolVersion: '2025-03-26', serverInfo: { name: 'test' } } });
    if (p.method === 'notifications/initialized') return response('', 202);
    return response({ jsonrpc: '2.0', id: 2, result });
  };
}
const toolResult = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

test('rejects write actions without network', async () => {
  const call = load(() => { throw new Error('must not fetch'); });
  assert.equal((await call({ action: 'cart' })).error.code, 'INVALID_INPUT');
});
test('validates search before network', async () => {
  const call = load(() => { throw new Error('must not fetch'); });
  for (const input of [{ action: 'search', query: '' }, { action: 'search', query: 'milk', limit: 100 },
    { action: 'search', query: 'milk', sort: 'invented' }, { action: 'details', id: -1 }]) {
    assert.equal((await call(input)).error.code, 'INVALID_INPUT');
  }
});
test('ping initializes without product calls', async () => {
  const requests = [];
  const call = load(mock({}, requests));
  assert.equal((await call({ action: 'ping' })).result.connected, true);
  assert.deepEqual(requests.map(x => x.method), ['initialize', 'notifications/initialized']);
});
test('search trims products and never calls cart', async () => {
  const requests = [];
  const call = load(mock(toolResult({ ok: true, data: { meta: { total: 1 }, items: [
    { id: 7, name: 'Молоко&nbsp;1 л', price: { current: 100 }, url: 'https://vkusvill.ru/goods/milk/', images: ['huge'] },
  ] } }), requests));
  const out = await call({ action: 'search', query: 'молоко', limit: 2 });
  assert.equal(out.result.products[0].name, 'Молоко 1 л');
  assert.equal(out.result.products[0].images, undefined);
  assert.equal(requests[2].params.name, 'vkusvill_products_search');
});
test('details preserves ingredient data', async () => {
  const call = load(mock(toolResult({ ok: true, data: { id: 7, name: 'Молоко', properties: [
    { name: 'Состав', value: '<b>молоко</b>' },
  ] } }), []));
  const out = await call({ action: 'details', id: 7 });
  assert.equal(out.result.product.properties[0].value, 'молоко');
});
test('backend application errors are not success', async () => {
  const call = load(mock(toolResult({ ok: false, error: { message: 'Backend failed' } }), []));
  assert.equal((await call({ action: 'search', query: 'milk' })).error.code, 'VKUSVILL_ERROR');
});
test('reports WebView fetch failure', async () => {
  const call = load(async () => { throw new TypeError('Failed to fetch'); });
  assert.equal((await call({ action: 'ping' })).error.code, 'NETWORK_OR_CORS');
});
test('HTTP errors remain distinct', async () => {
  const call = load(async () => response('', 401));
  assert.equal((await call({ action: 'ping' })).error.code, 'HTTP_401');
});
test('SSE initialize response is accepted', async () => {
  let count = 0;
  const call = load(async () => ++count === 1 ? response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","serverInfo":{"name":"test"}}}\n\n', 200, 'text/event-stream') : response('', 202));
  assert.equal((await call({ action: 'ping' })).result.connected, true);
});
