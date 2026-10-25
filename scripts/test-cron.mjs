// Tests for GET /api/cron-release-stale — auth gate, CAS release, stock
// restoration. No network, no npm deps.
//
//   node scripts/test-cron.mjs

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
process.env.SUPABASE_ANON_KEY = 'anon-test-key';
process.env.CRON_SECRET = 'cron-test-secret';
delete process.env.RESEND_API_KEY;

const { default: handler } = await import('../api/cron-release-stale.js');

const STALE_ORDER = {
  reference: 'PA-TEST2', payment_method: 'stripe', payment_status: 'pending',
  status: 'new', created_at: '2020-01-01T00:00:00.000Z',
  items: [{ product_id: 'aaaa-1111', qty: 2 }, { product_id: 'bbbb-2222', qty: 1 }],
  email: 'asha@example.com', name: 'Asha Rao',
  total_paise: 107800,
};

let staleRows = [STALE_ORDER];
let casWins = true;          // does the conditional update land?
const patches = [];          // every PATCH to /rest/v1/orders
const rpcCalls = [];         // every RPC invocation

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();

  if (u.includes('/rest/v1/orders') && method === 'GET') {
    return new Response(JSON.stringify(u.includes('payment_method=eq.stripe') ? staleRows : []), { status: 200 });
  }
  if (u.includes('/rest/v1/orders') && method === 'PATCH') {
    const match = Object.fromEntries(
      new URL(u).searchParams.toString().split('&').map(kv => {
        const [k, v] = kv.split('=').map(decodeURIComponent);
        return [k, String(v).startsWith('eq.') ? String(v).slice(3) : v];
      })
    );
    const patch = JSON.parse(opts.body);
    patches.push({ match, patch });
    if (!casWins) return new Response(JSON.stringify([]), { status: 200 });
    return new Response(JSON.stringify([{ ...STALE_ORDER, ...patch }]), { status: 200 });
  }
  if (u.includes('/rest/v1/rpc/')) {
    rpcCalls.push({ name: u.split('/rpc/')[1], args: JSON.parse(opts.body || '{}') });
    return new Response(JSON.stringify(u.includes('restore_stock') ? null : 'ok'), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function get(headers = {}) {
  return new Promise(resolve => {
    const res = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(chunk) {
        let parsed = {};
        try { parsed = JSON.parse(chunk); } catch {}
        resolve({ status: this.statusCode, body: parsed });
      },
    };
    handler({ method: 'GET', headers }, res);
  });
}

function reset() {
  staleRows = [STALE_ORDER];
  casWins = true;
  patches.length = 0;
  rpcCalls.length = 0;
}

console.log('\napi/cron-release-stale.js\n');

// 1. auth gate
reset();
{
  const r = await get();
  check('rejects a missing Authorization header', r.status === 403, `got ${r.status}`);
  check('an unauthenticated call touches nothing', patches.length === 0 && rpcCalls.length === 0);
}
reset();
{
  const r = await get({ authorization: 'Bearer wrong-secret' });
  check('rejects a wrong bearer token', r.status === 403, `got ${r.status}`);
  check('a wrong token touches nothing', patches.length === 0 && rpcCalls.length === 0);
}
{
  const saved = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  // The module reads the env per call, so this exercises the unset path.
  const r = await get({ authorization: `Bearer ${saved}` });
  check('refuses to run without CRON_SECRET configured', r.status === 503, `got ${r.status}`);
  process.env.CRON_SECRET = saved;
}

// 2. happy path: stale pending order is cancelled and its stock restored
reset();
{
  const r = await get({ authorization: 'Bearer cron-test-secret' });
  const p = patches[0] && patches[0].patch;
  check('releases a stale pending order', r.status === 200 && r.body.released === 1,
    `status ${r.status}, body ${JSON.stringify(r.body)}`);
  check('the cancel is conditional (CAS on pending + new)', patches[0] &&
    patches[0].match.payment_status === 'pending' && patches[0].match.status === 'new',
    JSON.stringify(patches[0] && patches[0].match));
  check('the order is marked cancelled', p && p.status === 'cancelled');
  const restores = rpcCalls.filter(c => c.name === 'restore_stock');
  check('stock is restored for every line item', restores.length === 2 &&
    restores.some(c => c.args.p_product_id === 'aaaa-1111' && c.args.p_qty === 2) &&
    restores.some(c => c.args.p_product_id === 'bbbb-2222' && c.args.p_qty === 1),
    JSON.stringify(rpcCalls));
  check('no buyer email is sent by the cron', !rpcCalls.some(c => c.name.includes('email')));
}

// 3. race: a payment landed while the cron ran → CAS finds 0 rows → no restock
reset();
{
  casWins = false;
  const r = await get({ authorization: 'Bearer cron-test-secret' });
  check('a concurrently-paid order is not released', r.status === 200 && r.body.released === 0,
    `body ${JSON.stringify(r.body)}`);
  check('no stock is restored when the CAS lost the race',
    !rpcCalls.some(c => c.name === 'restore_stock'),
    JSON.stringify(rpcCalls));
}

// 4. nothing stale → nothing happens
reset();
{
  staleRows = [];
  const r = await get({ authorization: 'Bearer cron-test-secret' });
  check('an empty backlog is a no-op', r.status === 200 && r.body.released === 0 &&
    patches.length === 0 && rpcCalls.length === 0, JSON.stringify(r.body));
}

globalThis.fetch = realFetch;

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
