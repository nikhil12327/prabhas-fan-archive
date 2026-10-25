
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const cfg=window.__ARCHIVE_CONFIG__||{};
const ONLINE=Boolean(cfg.enabled&&window.supabase);
const db=ONLINE?window.supabase.createClient(cfg.supabaseUrl,cfg.anonKey):null;
const esc=window.ArchiveSanitize.esc;
// supabase-js v2 returns {data:{publicUrl}}; older builds return {publicUrl}.
const safeUrl=window.ArchiveSanitize.safeUrl;
const safePath=window.ArchiveSanitize.safePath;
const num=window.ArchiveSanitize.num;
const pubUrl=(bucket,path)=>{const r=db.storage.from(bucket).getPublicUrl(path||'');return (r&&r.data&&r.data.publicUrl)||(r&&r.publicUrl)||''};
const inr=p=>'₹'+(p/100).toLocaleString('en-IN',{maximumFractionDigits:2});
const when=iso=>new Date(iso).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
function flash(el,t,k){el.textContent=t;el.className='msg '+(k||'ok');el.hidden=false}
function hide(el){el.hidden=true}

if(!ONLINE){
  flash($('#lmsg'),'Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY, then rebuild.','err');
}

/* ---------------- auth ---------------- */
async function session(){
  if(!ONLINE)return null;
  const {data}=await db.auth.getSession();
  return data.session;
}
function showApp(session){
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#who').hidden=false;
  $('#whoami').textContent=session.user.email;
  loadAll();
}

$('#lsub').addEventListener('click',async e=>{
  e.preventDefault();
  if(!ONLINE)return;
  const {error}=await db.auth.signInWithPassword({email:$('#lemail').value.trim(),password:$('#lpass').value});
  if(error)flash($('#lmsg'),error.message,'err');else location.reload();
});
// NOTE: public account creation was removed on purpose. Owner accounts are
// created once in Supabase → Authentication → Users (then inserted into
// public.admins); leaving an open signUp here would let anyone mint auth
// accounts against the project.
$('#signout').addEventListener('click',async()=>{await db.auth.signOut();location.reload()});

db&&db.auth.onAuthStateChange((e,s)=>{if(e==='SIGNED_IN'&&s)showApp(s)});

/* ---------------- tabs ---------------- */
$$('.tabs button').forEach(b=>b.addEventListener('click',()=>{
  $$('.tabs button').forEach(x=>x.setAttribute('aria-selected',x===b));
  $$('#app section').forEach(s=>s.classList.toggle('hidden',s.id!=='t-'+b.dataset.t));
}));

/* ---------------- moderation ---------------- */
async function moderate(id,action,kind){
  const {data:{session}}=await db.auth.getSession();
  const r=await fetch('/api/moderate',{
    method:'POST',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+session.access_token},
    body:JSON.stringify({id,action,kind:kind||'photo'})
  });
  const out=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(out.error||'Request failed');
  return out;
}
function bindModerate(container,selector){
  container.addEventListener('click',async e=>{
    const b=e.target.closest('[data-act]');
    if(!b)return;
    b.disabled=true;
    try{
      await moderate(b.dataset.id,b.dataset.act,b.dataset.kind);
      flash($('#amsg'),b.dataset.act==='approve'?'Approved.':'Rejected.','ok');
      b.closest(selector).remove();
    }catch(err){
      flash($('#amsg'),err.message,'err');
      b.disabled=false;
    }
  });
}

/* ---------------- loaders ---------------- */
async function loadSubs(){
  const {data,error}=await db.from('photo_submissions').select('*').eq('status','pending').order('created_at',{ascending:false});
  const box=$('#subs');
  if(error)return box.innerHTML=`<p class="empty">${esc(error.message)}</p>`;
  if(!data.length)return box.innerHTML='<p class="empty">Nothing waiting for review.</p>';
  box.innerHTML=data.map(p=>`
    <div class="card">
      <img class="thumb" src="${esc(safeUrl(pubUrl('submissions',safePath(p.storage_path))))}" alt="" loading="lazy">
      <p class="meta"><b>${esc(p.name)}</b> · ${esc(p.email)}<br>${p.caption?esc(p.caption)+'<br>':''}${when(p.created_at)}</p>
      <div class="row">
        <button class="btn go sm" data-act="approve" data-id="${p.id}">Approve</button>
        <button class="btn no sm" data-act="reject" data-id="${p.id}">Reject</button>
      </div>
    </div>`).join('');
  bindModerate(box,'.card');
}

async function loadWishes(){
  const {data,error}=await db.from('wishes').select('*').eq('status','pending').order('created_at',{ascending:false});
  const box=$('#wishes');
  if(error)return box.innerHTML=`<p class="empty">${esc(error.message)}</p>`;
  if(!data.length)return box.innerHTML='<p class="empty">No wishes waiting.</p>';
  box.innerHTML=data.map(w=>`
    <div class="card">
      <p class="meta"><b>${esc(w.name)}</b> · ${when(w.created_at)}</p>
      <p style="margin:8px 0 0;color:#d6d7de">${esc(w.message)}</p>
      <div class="row">
        <button class="btn go sm" data-act="approve" data-kind="wish" data-id="${w.id}">Approve</button>
        <button class="btn no sm" data-act="reject" data-kind="wish" data-id="${w.id}">Reject</button>
      </div>
    </div>`).join('');
  bindModerate(box,'.card');
}

async function loadOrders(){
  const {data,error}=await db.from('orders').select('*').order('created_at',{ascending:false}).limit(100);
  const box=$('#orders');
  if(error)return box.innerHTML=`<p class="empty">${esc(error.message)}</p>`;
  if(!data.length)return box.innerHTML='<p class="empty">No orders yet.</p>';
  box.innerHTML=`<div class="card" style="overflow-x:auto"><table>
    <thead><tr><th>Ref</th><th>Customer</th><th>Items</th><th class="num">Total</th><th>Pay</th><th>Status</th></tr></thead>
    <tbody>${data.map(o=>`<tr>
      <td><b>${esc(o.reference)}</b><br><span style="color:var(--sm)">${when(o.created_at)}</span></td>
      <td>${esc(o.name)}<br><a href="mailto:${esc(o.email)}">${esc(o.email)}</a><br>
        <span style="color:var(--sm)">${esc(o.address_line1)}, ${esc(o.city)}, ${esc(o.state)} ${esc(o.pincode)}</span></td>
      <td>${o.items.map(i=>`${i.qty}× ${esc(i.name)}`).join('<br>')}</td>
      <td class="num">${inr(o.total_paise)}</td>
      <td><span class="pill ${o.payment_status==='paid'?'paid':'pending'}">${o.payment_method==='cod'?'COD':o.payment_method==='upi'?'UPI':o.payment_method==='razorpay'?'Razorpay':'Card'} ${esc(o.payment_status)}</span></td>
      <td><select data-ref="${o.reference}">
        ${['new','confirmed','shipped','delivered','cancelled'].map(s=>`<option ${s===o.status?'selected':''}>${s}</option>`).join('')}
      </select></td>
    </tr>`).join('')}</tbody></table></div>`;
  box.querySelectorAll('select').forEach(s=>s.addEventListener('change',async()=>{
    try{
      const {error:e}=await db.from('orders').update({status:s.value}).eq('reference',s.dataset.ref);
      if(e)throw e;
      flash($('#amsg'),'Order '+s.dataset.ref+' → '+s.value,'ok');
    }catch(e){flash($('#amsg'),e.message,'err')}
  }));
}

async function loadProducts(){
  const {data,error}=await db.from('merch_products').select('*').order('sort_order',{ascending:true});
  const box=$('#plist');
  if(error)return box.innerHTML=`<p class="empty">${esc(error.message)}</p>`;
  if(!data.length)return box.innerHTML='<p class="empty">No products yet.</p>';
  box.innerHTML=`<div class="card" style="overflow-x:auto"><table>
    <thead><tr><th>Photo</th><th>Product</th><th class="num">Price</th><th class="num">Stock</th><th>Active</th><th></th></tr></thead>
    <tbody>${data.map(p=>`<tr>
      <td>${p.image_path?`<img src="${esc(safeUrl(pubUrl('merch',safePath(p.image_path))))}" alt="" loading="lazy">`:'<span style="color:var(--sm)">—</span>'}</td>
      <td><b>${esc(p.name)}</b><br><span style="color:var(--sm)">${esc(p.description||'')}</span></td>
      <td class="num">${inr(p.price_paise)}</td>
      <td class="num">${p.stock==null?'∞':p.stock}</td>
      <td><label style="margin:0;text-transform:none;letter-spacing:0"><input type="checkbox" data-on="${p.id}" ${p.active?'checked':''} style="width:auto"> ${p.active?'Live':'Hidden'}</label></td>
      <td class="num"><button class="btn sm" data-del="${p.id}">Delete</button></td>
    </tr>`).join('')}</tbody></table></div>`;

  box.querySelectorAll('[data-on]').forEach(c=>c.addEventListener('change',async()=>{
    try{const {error:e}=await db.from('merch_products').update({active:c.checked}).eq('id',c.dataset.on);if(e)throw e;loadProducts()}
    catch(e){flash($('#amsg'),e.message,'err')}
  }));
  box.querySelectorAll('[data-del]').forEach(b=>b.addEventListener('click',async()=>{
    if(!confirm('Delete this product?'))return;
    try{const {error:e}=await db.from('merch_products').delete().eq('id',b.dataset.del);if(e)throw e;loadProducts()}
    catch(e){flash($('#amsg'),e.message,'err')}
  }));
}

async function loadScores(){
  const {data,error}=await db.from('quiz_scores').select('*').order('score',{ascending:false}).order('created_at',{ascending:true}).limit(50);
  const box=$('#scores');
  if(error)return box.innerHTML=`<p class="empty">${esc(error.message)}</p>`;
  if(!data.length)return box.innerHTML='<p class="empty">No scores recorded.</p>';
  box.innerHTML=`<div class="card" style="overflow-x:auto"><table>
    <thead><tr><th>#</th><th>Name</th><th class="num">Score</th><th>When</th><th></th></tr></thead>
    <tbody>${data.map((r,i)=>`<tr>
      <td>${i+1}</td><td>${esc(r.name)}</td>
      <td class="num">${r.score}/${r.total}</td>
      <td>${when(r.created_at)}</td>
      <td class="num"><button class="btn sm no" data-del="${r.id}">Remove</button></td>
    </tr>`).join('')}</tbody></table></div>`;
  box.querySelectorAll('[data-del]').forEach(b=>b.addEventListener('click',async()=>{
    try{const {error:e}=await db.from('quiz_scores').delete().eq('id',b.dataset.del);if(e)throw e;loadScores()}
    catch(e){flash($('#amsg'),e.message,'err')}
  }));
}

/* ---------------- product create ---------------- */
// live preview of the chosen photo
$('#pfile').addEventListener('change',()=>{
  const f=$('#pfile').files[0];
  if(!f){$('#pprev').hidden=true;return}
  $('#pprevimg').src=URL.createObjectURL(f);
  $('#pprev').hidden=false;
});
$('#pclear').addEventListener('click',()=>{$('#pfile').value='';$('#pprev').hidden=true});

$('#pform').addEventListener('submit',async e=>{
  e.preventDefault();
  if(!ONLINE)return;
  const name=$('#pname').value.trim(),price=Math.round(parseFloat($('#pprice').value));
  if(!name||!Number.isFinite(price)||price<0)return flash($('#pmsg'),'Name and a valid price are required.','err');
  const file=$('#pfile').files[0];
  if(file){
    if(!file.type.startsWith('image/'))return flash($('#pmsg'),'That file is not an image.','err');
    if(file.size>5*1024*1024)return flash($('#pmsg'),'Photos must be under 5 MB.','err');
  }
  const stockRaw=$('#pstock').value.trim();
  const btn=$('#psub');btn.disabled=true;btn.textContent='Adding…';
  try{
    let image_path=null;
    if(file){
      const safe=(file.name.toLowerCase().replace(/\.\.+/g,'.').replace(/[^a-z0-9.]+/g,'-').replace(/^-|-$/g,'')||'product')
        .replace(/\.(jpg|jpeg|png|webp)$/,'')+'.jpg';
      const path=`${Date.now()}-${Math.random().toString(36).slice(2,8)}-${safe}`;
      if(!safePath(path))throw new Error('unsafe file name');
      const up=await db.storage.from('merch').upload(path,file,{contentType:file.type,upsert:false});
      if(up.error)throw up.error;
      image_path=path;
    }
    const row={
      name,description:$('#pdesc').value.trim()||null,
      price_paise:Math.round(price*100),
      stock:stockRaw===''?null:Math.max(0,parseInt(stockRaw,10)),
      image_path,
      active:true,sort_order:99
    };
    const {error}=await db.from('merch_products').insert(row);
    if(error)throw error;
    $('#pform').reset();
    $('#pprev').hidden=true;
    flash($('#amsg'),'Product added.','ok');
    loadProducts();
  }catch(err){flash($('#pmsg'),err.message,'err')}
  finally{btn.disabled=false;btn.textContent='Add product'}
});

/* ---------------- boot ---------------- */
function loadAll(){loadSubs();loadWishes();loadOrders();loadProducts();loadScores()}
session().then(s=>{if(s)showApp(s)});
