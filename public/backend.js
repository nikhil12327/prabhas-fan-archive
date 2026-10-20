/* =====================================================================
   Prabhas — The Fan Archive : connected features
   Loaded after /config.js and the Supabase client.
   Adds: photo wall, birthday wishes, quiz leaderboard, merch + orders.
   Everything degrades to a read-only/static site if `enabled` is false.
   ===================================================================== */
(function () {
  'use strict';

  const cfg = window.__ARCHIVE_CONFIG__ || { enabled: false };
  const ONLINE = Boolean(cfg.enabled && window.supabase);
  const db = ONLINE ? window.supabase.createClient(cfg.supabaseUrl, cfg.anonKey) : null;

  const q = (s, r) => (r || document).querySelector(s);
  const qa = (s, r) => [...(r || document).querySelectorAll(s)];

  /** ₹ from paise, without float drift. */
  const inr = p => '₹' + (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const shortDate = iso => new Date(iso).toLocaleDateString('en-IN',
    { day: 'numeric', month: 'short', year: 'numeric' });

  /** supabase-js v2 returns {data:{publicUrl}}; older builds return {publicUrl}. */
  function pubUrl(bucket, path) {
    const r = db.storage.from(bucket).getPublicUrl(path || '');
    return (r && r.data && r.data.publicUrl) || (r && r.publicUrl) || '';
  }

  function flash(el, msg, kind) {
    if (!el) return;
    el.textContent = msg;
    el.className = 'fmsg ' + (kind || 'ok');
    el.hidden = false;
  }

  async function call(path, payload) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  }

  /* ================================================================
     1. PHOTO WALL  (Fan zone)
     ================================================================ */
  async function initPhotoWall() {
    const grid = q('#pwgrid'), form = q('#pwform'), msg = q('#pwmsg'), file = q('#pwfile');
    if (!grid) return;

    if (!ONLINE) { grid.innerHTML = '<p class="empty">Connect Supabase to open submissions.</p>'; return; }

    // --- approved wall ---
    try {
      const { data, error } = await db.from('photo_submissions')
        .select('id, name, caption, wall_path')
        .eq('status', 'approved')
        .order('reviewed_at', { ascending: false })
        .limit(60);
      if (error) throw error;
      grid.innerHTML = data.length
        ? data.map(p => `
          <figure class="pwcard">
            <img src="${pubUrl('wall', p.wall_path)}"
                 alt="Photo submitted by ${esc(p.name)}" loading="lazy">
            <figcaption>${p.caption ? esc(p.caption) : ''}<span>${esc(p.name)}</span></figcaption>
          </figure>`).join('')
        : '<p class="empty">No approved photos yet — be the first.</p>';
    } catch (e) {
      console.error('[wall] load failed', e);
      grid.innerHTML = '<p class="empty">The wall could not be loaded right now.</p>';
    }

    // --- upload ---
    if (!form) return;
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const name = q('#pwname').value.trim();
      const email = q('#pwemail').value.trim();
      const caption = q('#pwcaption').value.trim();
      const f = file.files[0];

      if (!f) return flash(msg, 'Choose a photo first.', 'err');
      if (!name || !email) return flash(msg, 'Name and email are required.', 'err');
      if (!f.type.startsWith('image/')) return flash(msg, 'That file is not an image.', 'err');
      if (f.size > 8 * 1024 * 1024) return flash(msg, 'Images must be under 8 MB.', 'err');

      const btn = q('#pwsubmit', form);
      btn.disabled = true; btn.textContent = 'Uploading…';
      try {
        const safe = f.name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '') || 'photo.jpg';
        const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;

        const up = await db.storage.from('submissions').upload(path, f, {
          contentType: f.type, upsert: false,
        });
        if (up.error) throw up.error;

        const ins = await db.from('photo_submissions').insert({
          name, email, caption: caption || null, storage_path: path,
        });
        if (ins.error) throw ins.error;

        form.reset();
        flash(msg, 'Received! Your photo will appear once the owner approves it.', 'ok');
      } catch (e) {
        console.error('[wall] upload failed', e);
        flash(msg, 'Upload failed — please try again.', 'err');
      } finally {
        btn.disabled = false; btn.textContent = 'Submit for approval';
      }
    });
  }

  /* ================================================================
     2. BIRTHDAY WISHES
     ================================================================ */
  async function initWishes() {
    const list = q('#wslist'), form = q('#wsform'), msg = q('#wsmsg');
    if (!list) return;

    if (!ONLINE) { list.innerHTML = '<p class="empty">Connect Supabase to open wishes.</p>'; return; }

    const load = async () => {
      try {
        const { data, error } = await db.from('wishes')
          .select('name, message, created_at')
          .eq('status', 'approved')
          .order('created_at', { ascending: false })
          .limit(30);
        if (error) throw error;
        list.innerHTML = data.length
          ? data.map(w => `<blockquote class="ws"><p>${esc(w.message)}</p>
               <cite>${esc(w.name)}<span>${shortDate(w.created_at)}</span></cite></blockquote>`).join('')
          : '<p class="empty">No wishes published yet.</p>';
      } catch (e) {
        console.error('[wishes] load failed', e);
        list.innerHTML = '<p class="empty">Wishes could not be loaded right now.</p>';
      }
    };
    await load();

    if (!form) return;
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const name = q('#wsname').value.trim();
      const message = q('#wsbody').value.trim();
      if (!name || !message) return flash(msg, 'Please add your name and a message.', 'err');
      if (message.length > 400) return flash(msg, 'Keep it under 400 characters.', 'err');
      try {
        const { error } = await db.from('wishes').insert({ name, message });
        if (error) throw error;
        form.reset();
        flash(msg, 'Thank you! Your wish appears after approval.', 'ok');
      } catch (e) {
        console.error('[wishes] insert failed', e);
        flash(msg, 'Could not send your wish. Please try again.', 'err');
      }
    });
  }

  /* ================================================================
     3. QUIZ LEADERBOARD
     ================================================================ */
  async function loadLeaderboard() {
    const box = q('#lblist');
    if (!box) return;
    if (!ONLINE) { box.innerHTML = '<p class="empty">Connect Supabase to show the leaderboard.</p>'; return; }
    try {
      const { data, error } = await db.from('quiz_scores')
        .select('name, score, total, created_at')
        .order('score', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(10);
      if (error) throw error;
      box.innerHTML = data.length
        ? `<ol class="lb">${data.map((r, i) => `<li><b>${i + 1}</b><span>${esc(r.name)}</span>
             <em>${r.score}/${r.total}</em></li>`).join('')}</ol>`
        : '<p class="empty">No scores yet — take the quiz and top the board.</p>';
    } catch (e) {
      console.error('[lb] load failed', e);
      box.innerHTML = '<p class="empty">Leaderboard unavailable right now.</p>';
    }
  }

  /* Detect the quiz result screen and attach a name form to it. */
  function hookQuiz() {
    const zone = q('#qz');
    if (!zone || !ONLINE) return;
    let armed = false;

    const arm = () => {
      const res = q('.res', zone);
      if (!res) return;                 // no result screen yet
      if (res.dataset.lb) return;        // already armed this round
      res.dataset.lb = '1';

      const score = (q('.sil', res) || {}).textContent || '';
      const form = document.createElement('form');
      form.className = 'lbform';
      form.innerHTML =
        `<p class="lbhint">You scored <b>${esc(score)}</b> — add it to the leaderboard.</p>
         <div class="lbrow">
           <input id="lbname" maxlength="40" placeholder="Your name" required>
           <button class="opt" type="submit">Submit score</button>
         </div>
         <p class="fmsg" id="lbmsg" hidden></p>`;
      res.appendChild(form);

      form.addEventListener('submit', async ev => {
        ev.preventDefault();
        const name = q('#lbname', form).value.trim();
        const msgEl = q('#lbmsg', form);
        const m = /^(\d+)\s*\/\s*(\d+)$/.exec(score);
        if (!name) return flash(msgEl, 'Enter a name.', 'err');
        if (!m) return flash(msgEl, 'Score could not be read.', 'err');
        try {
          const { error } = await db.from('quiz_scores')
            .insert({ name, score: +m[1], total: +m[2] });
          if (error) throw error;
          form.remove();
          loadLeaderboard();
        } catch (e) {
          console.error('[lb] insert failed', e);
          flash(msgEl, 'Could not save your score.', 'err');
        }
      });
    };

    new MutationObserver(arm).observe(zone, { childList: true, subtree: true });
    arm();
  }

  /* ================================================================
     4. MERCH CATALOGUE + CART + ORDER
     ================================================================ */
  const CART_KEY = 'pa_cart_v1';
  const readCart = () => { try { return JSON.parse(localStorage.getItem(CART_KEY)) || {}; } catch { return {}; } };
  const writeCart = c => localStorage.setItem(CART_KEY, JSON.stringify(c));

  let PRODUCTS = [];

  async function initMerch() {
    const grid = q('#mg');
    if (!grid) return;

    if (!ONLINE) {
      grid.innerHTML = '<p class="empty">Connect Supabase to load the catalogue.</p>';
      return;
    }

    try {
      const { data, error } = await db.from('merch_products')
        .select('*').eq('active', true).order('sort_order', { ascending: true });
      if (error) throw error;
      PRODUCTS = data || [];
    } catch (e) {
      console.error('[merch] load failed', e);
      grid.innerHTML = '<p class="empty">The catalogue could not be loaded.</p>';
      return;
    }

    if (!PRODUCTS.length) {
      grid.innerHTML = '<p class="empty">The shop is being restocked — check back soon.</p>';
      return;
    }

    grid.innerHTML = PRODUCTS.map(p => {
      const img = p.image_path
        ? `<div class="im" style="background-image:url('${pubUrl('merch', p.image_path)}')"></div>`
        : '<div class="im"></div>';
      const stock = p.stock != null && p.stock <= 0;
      return `<article class="mi rv in" data-p="${p.id}">
        <div class="x">${img}</div>
        <em>${stock ? 'SOLD OUT' : 'IN STOCK'}</em>
        <h3>${esc(p.name)}</h3>
        <p>${esc(p.description || '')}<br><b class="price">${inr(p.price_paise)}</b></p>
        <button class="opt add" data-add="${p.id}" ${stock ? 'disabled' : ''}>
          ${stock ? 'Sold out' : 'Add to cart'}
        </button>
      </article>`;
    }).join('');

    renderCart();
    q('#merch') && q('#merch').addEventListener('click', onMerchClick);
  }

  function onMerchClick(ev) {
    const add = ev.target.closest('[data-add]');
    if (add) {
      const id = add.dataset.add;
      const c = readCart();
      c[id] = (c[id] || 0) + 1;
      writeCart(c);
      renderCart();
      add.textContent = 'Added ✓';
      setTimeout(() => { add.textContent = 'Add to cart'; }, 1100);
      return;
    }
    const rm = ev.target.closest('[data-rm]');
    if (rm) {
      const c = readCart();
      const id = rm.dataset.rm;
      c[id] = (c[id] || 0) - 1;
      if (c[id] <= 0) delete c[id];
      writeCart(c);
      renderCart();
    }
  }

  function cartLines() {
    const c = readCart();
    return Object.entries(c)
      .map(([id, qty]) => { const p = PRODUCTS.find(x => x.id === id); return p ? { p, qty } : null; })
      .filter(Boolean);
  }

  function renderCart() {
    const box = q('#cartbox'), form = q('#orderform');
    if (!box) return;
    const lines = cartLines();

    if (!lines.length) {
      box.innerHTML = '<p class="empty">Your cart is empty. Add something above.</p>';
      if (form) form.hidden = true;
      q('#cartsummary').innerHTML = '';
      return;
    }

    box.innerHTML = lines.map(({ p, qty }) => `
      <div class="cline">
        <span class="cn">${esc(p.name)}</span>
        <span class="cq">
          <button class="opt" data-rm="${p.id}" aria-label="Remove one">−</button>
          <b>${qty}</b>
          <button class="opt" data-add="${p.id}" aria-label="Add one">+</button>
        </span>
        <span class="cp">${inr(p.price_paise * qty)}</span>
      </div>`).join('');

    const subtotal = lines.reduce((s, l) => s + l.p.price_paise * l.qty, 0);
    const shipping = subtotal >= 199900 ? 0 : 7900;
    q('#cartsummary').innerHTML =
      `<div class="ctot"><span>Subtotal</span><b>${inr(subtotal)}</b></div>
       <div class="ctot"><span>Shipping</span><b>${shipping ? inr(shipping) : 'Free'}</b></div>
       <div class="ctot grand"><span>Total</span><b>${inr(subtotal + shipping)}</b></div>`;

    if (form) form.hidden = false;
  }

  function initOrderForm() {
    const form = q('#orderform');
    if (!form) return;
    const msg = q('#ordmsg');

    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const lines = cartLines();
      if (!lines.length) return flash(msg, 'Your cart is empty.', 'err');

      const pay = (q('input[name="pay"]:checked', form) || {}).value || 'cod';
      const btn = q('#ordersubmit', form);
      btn.disabled = true; btn.textContent = 'Placing order…';

      try {
        const res = await call('/api/orders', {
          name: q('#oname').value.trim(),
          email: q('#oemail').value.trim().toLowerCase(),
          phone: q('#ophone').value.trim(),
          address_line1: q('#oaddr1').value.trim(),
          address_line2: q('#oaddr2').value.trim(),
          city: q('#ocity').value.trim(),
          state: q('#ostate').value.trim(),
          pincode: q('#opin').value.trim(),
          payment_method: pay,
          items: lines.map(l => ({ product_id: l.p.id, qty: l.qty })),
        });

        if (res.url) { location.href = res.url; return; }   // Stripe redirect
        writeCart({}); renderCart(); form.reset();
        flash(msg, `Order ${res.reference} placed! We've emailed you a confirmation.`, 'ok');
        showConfirmation(res.reference, true);
      } catch (e) {
        flash(msg, e.message, 'err');
      } finally {
        btn.disabled = false; btn.textContent = 'Place order';
      }
    });
  }

  function showConfirmation(ref, cod) {
    let panel = q('#orderdone');
    if (!panel) return;
    panel.hidden = false;
    panel.innerHTML = cod
      ? `<b>Order ${esc(ref)} received.</b><p>Pay on delivery. A confirmation is on its way to your inbox.</p>`
      : `<b>Payment received — order ${esc(ref)}.</b><p>A receipt is on its way to your inbox.</p>`;
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* Coming back from Stripe: /?order=PA-XXXXX&paid=1#/merch */
  function handleReturn() {
    const p = new URLSearchParams(location.search);
    const ref = p.get('order');
    if (!ref) return;
    writeCart({});
    showConfirmation(ref, !(p.get('paid') === '1'));
    p.delete('order'); p.delete('paid'); p.delete('cancelled');
    const qs = p.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  }

  /* ================================================================
     BOOT
     ================================================================ */
  async function boot() {
    // Always run the section initialisers: they each render an informative
    // offline state when Supabase is not configured, instead of leaving a
    // permanent "Loading…" placeholder.
    handleReturn();
    await Promise.allSettled([initPhotoWall(), initWishes(), initMerch(), loadLeaderboard()]);
    if (!ONLINE) return;
    hookQuiz();
    initOrderForm();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
