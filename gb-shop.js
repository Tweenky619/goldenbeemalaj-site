// Goldenbee MALAJ — site-wide cart + checkout experience.
// Product markup: .buy-row (data-series / data-denomination / data-face-value)
// with a .buy-qty input and a .buy-btn. Cart lives in localStorage across pages.
// Prices are always recomputed on the server at checkout; the cart only shows
// a quote that holds until Goldback's next daily update (9 AM Pacific Time).
(function () {
  var CART_KEY = 'gbm_cart', LOCK_KEY = 'gbm_price_lock', CODE_KEY = 'gbm_code', DELIV_KEY = 'gbm_delivery';
  var LOCK_DURATION_MS = 10 * 60 * 1000;
  var FREE_SHIP_CENTS = 19999, SHIP_CENTS = 999;
  var PHONE = '(619) 504-8977', PHONE_HREF = 'tel:+16195048977';

  // ---------- storage ----------
  function rd(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function wr(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function getCart() { return rd(CART_KEY, []); }
  var listeners = [];
  function setCart(c) { wr(CART_KEY, c); renderBadge(); listeners.forEach(function (f) { try { f(); } catch (e) {} }); }
  function getCode() { var c = rd(CODE_KEY, null); if (c && c.expires_at && new Date(c.expires_at) < new Date()) { wr(CODE_KEY, null); return null; } return c; }
  function getDelivery() { return rd(DELIV_KEY, 'ship') === 'pickup' ? 'pickup' : 'ship'; }

  function addToCart(item) {
    var cart = getCart();
    var ex = cart.find(function (c) { return c.series === item.series && c.denomination === item.denomination; });
    if (ex) { ex.quantity = Math.min(999, ex.quantity + item.quantity); if (item.img) ex.img = item.img; }
    else cart.push(item);
    setCart(cart);
  }
  function setQtyFor(item, q) {
    var c = getCart(), i = c.findIndex(function (x) { return x.series === item.series && x.denomination === item.denomination; });
    if (q <= 0) { if (i >= 0) c.splice(i, 1); }
    else if (i >= 0) c[i].quantity = Math.min(999, q);
    else c.push({ series: item.series, denomination: item.denomination, faceValueGB: item.faceValueGB, quantity: Math.min(999, q), img: item.img || null });
    setCart(c); if (!drawer.hidden) renderDrawer();
  }
  function updateQty(i, q) { var c = getCart(); if (!c[i]) return; if (q <= 0) c.splice(i, 1); else c[i].quantity = Math.min(999, q); setCart(c); renderDrawer(); }

  // ---------- price quote ----------
  function totalQtyOf(cart) { return cart.reduce(function (s, i) { return s + i.faceValueGB * i.quantity; }, 0); }
  function isLockValid(l, q) { if (!l || l.qty !== q) return false; return l.until ? Date.now() < l.until : Date.now() - l.lockedAt < LOCK_DURATION_MS; }
  function ensureLock(q, cb) {
    var l = rd(LOCK_KEY, null);
    if (isLockValid(l, q)) return cb(l);
    fetch('/api/pricing?qty=' + encodeURIComponent(q)).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) return cb(null);
      var f = { qty: q, priceCents: d.pricePerGoldbackCents, dailyCents: d.dailyCents || null, until: d.lockUntil || null, lockedAt: Date.now() };
      wr(LOCK_KEY, f); cb(f);
    }).catch(function () { cb(null); });
  }
  // Same math as the server: promo never takes the price below Goldback's daily rate.
  function effPrice(lock, code) {
    var p = lock.priceCents;
    if (code && code.discount_bps) { var d = Math.round(p * (1 - code.discount_bps / 10000)); p = Math.max(lock.dailyCents || 0, d); }
    return p;
  }

  // ---------- helpers ----------
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function usd(c) { return '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function untilLabel(u) { try { return new Date(u).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); } catch (e) { return '9 AM Pacific Time'; } }
  function left(u) { var ms = u - Date.now(), h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000); return (h > 0 ? h + 'h ' : '') + Math.max(0, m) + 'm'; }
  var ICON = {
    bag: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 7h12l-1 13H7L6 7z"/><path d="M9 7a3 3 0 0 1 6 0"/></svg>',
    lock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    truck: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h11v10H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/></svg>',
    pin: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
    trash: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
    shield: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
    check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>'
  };

  // ---------- styles ----------
  var css = [
    ':root{--gbx-bg:#15110a;--gbx-card:#1f1910;--gbx-line:rgba(218,153,0,.22);--gbx-gold:#DA9900;--gbx-gold2:#FDDD3B;--gbx-cream:#FAF6EC;--gbx-mute:#b9ad94}',
    '.gb-cart-btn{background:transparent;border:1px solid rgba(250,246,236,.35);color:var(--gbx-cream);border-radius:999px;padding:.42rem .85rem;font:600 .9rem Arial,Helvetica,sans-serif;cursor:pointer;margin-left:.9rem;display:inline-flex;align-items:center;gap:.45rem}',
    '.gb-cart-btn:hover,.gb-cart-btn.has-items{border-color:var(--gbx-gold);color:var(--gbx-gold2)}',
    '.gb-cart-count{background:var(--gbx-gold);color:#1a1611;border-radius:999px;min-width:1.3rem;height:1.3rem;display:inline-flex;align-items:center;justify-content:center;font-size:.72rem;font-weight:700;padding:0 .3rem}',
    '.gb-cart-btn.bump{animation:gbxBump .5s}@keyframes gbxBump{30%{transform:scale(1.15)}}',
    /* product card stepper */
    '.buy-row.gbx-row{display:flex;flex-wrap:wrap;gap:.5rem;align-items:stretch}',
    '.gb-cart-drawer[hidden],.gb-cart-overlay[hidden]{display:none!important}',
    '.gbx-step{display:inline-flex;align-items:center;justify-content:space-between;flex:1 1 6.6rem;border:1px solid #d9cba8;border-radius:8px;overflow:hidden;background:#fff}',
    '.gbx-step button{width:2.1rem;height:2.4rem;border:0;background:transparent;font:700 1.1rem Arial,sans-serif;color:#6b5a2e;cursor:pointer}',
    '.gbx-step button:active{background:#f3ead2}',
    '.gbx-step input{width:2.4rem;height:2.4rem;border:0;text-align:center;font:600 .95rem Arial,sans-serif;-moz-appearance:textfield;background:transparent;color:#1a1611}',
    '.gbx-step input::-webkit-outer-spin-button,.gbx-step input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}',
    '.buy-row.gbx-row .buy-btn{flex:1 1 7.5rem;display:inline-flex;align-items:center;justify-content:center;gap:.35rem;min-height:2.4rem;white-space:nowrap}',
    '.buy-btn.gbx-added{background:#2e7d32!important;color:#fff!important}',
    /* drawer */
    '.gb-cart-overlay{position:fixed;inset:0;background:rgba(5,4,2,.6);z-index:1998;opacity:0;transition:opacity .25s}',
    '.gb-cart-overlay.open{opacity:1}',
    '.gb-cart-drawer{position:fixed;top:0;right:0;bottom:0;width:min(420px,100vw);background:var(--gbx-bg);color:var(--gbx-cream);z-index:1999;box-shadow:-10px 0 40px rgba(0,0,0,.5);display:flex;flex-direction:column;font-family:Arial,Helvetica,sans-serif;transform:translateX(100%);transition:transform .3s cubic-bezier(.2,.8,.2,1)}',
    '.gb-cart-drawer.open{transform:none}',
    '.gbx-head{display:flex;align-items:center;justify-content:space-between;padding:1.1rem 1.25rem;border-bottom:1px solid var(--gbx-line)}',
    '.gbx-head h3{margin:0;font:700 1.15rem Georgia,serif;color:var(--gbx-gold2);display:flex;align-items:center;gap:.5rem}',
    '.gbx-head h3 small{font:400 .8rem Arial,sans-serif;color:var(--gbx-mute)}',
    '.gbx-x{background:none;border:0;color:var(--gbx-mute);font-size:1.8rem;line-height:1;cursor:pointer;padding:.2rem .4rem}',
    '.gbx-body{flex:1;overflow-y:auto;padding:0 1.25rem}',
    '.gbx-foot{border-top:1px solid var(--gbx-line);padding:1rem 1.25rem calc(1rem + env(safe-area-inset-bottom));background:#120e08}',
    '.gbx-lock{display:flex;gap:.55rem;align-items:center;margin:1rem 0 .4rem;padding:.6rem .8rem;border:1px solid var(--gbx-line);border-radius:10px;background:var(--gbx-card);font-size:.8rem;color:var(--gbx-mute);line-height:1.35}',
    '.gbx-lock svg{color:var(--gbx-gold);flex:none}.gbx-lock b{color:var(--gbx-gold2);white-space:nowrap}',
    '.gbx-prog{margin:.8rem 0 .2rem;padding:.75rem .85rem;border-radius:10px;background:linear-gradient(135deg,rgba(218,153,0,.16),rgba(218,153,0,.05));border:1px solid var(--gbx-line);font-size:.83rem;line-height:1.4}',
    '.gbx-prog b{color:var(--gbx-gold2)}',
    '.gbx-bar{height:7px;border-radius:99px;background:rgba(250,246,236,.1);margin-top:.55rem;overflow:hidden}',
    '.gbx-bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--gbx-gold),var(--gbx-gold2));transition:width .4s}',
    '.gbx-item{display:flex;gap:.8rem;padding:.9rem 0;border-bottom:1px solid rgba(250,246,236,.07)}',
    '.gbx-thumb{width:58px;height:76px;border-radius:6px;object-fit:cover;background:var(--gbx-card);border:1px solid var(--gbx-line);flex:none}',
    '.gbx-thumb.ph{display:flex;align-items:center;justify-content:center;color:var(--gbx-gold);font:700 .8rem Georgia,serif}',
    '.gbx-info{flex:1;min-width:0}',
    '.gbx-name{font-weight:700;font-size:.95rem}.gbx-sub{color:var(--gbx-mute);font-size:.78rem;margin:.15rem 0 .5rem}',
    '.gbx-row2{display:flex;align-items:center;justify-content:space-between;gap:.5rem}',
    '.gbx-qs{display:inline-flex;align-items:center;border:1px solid var(--gbx-line);border-radius:8px;overflow:hidden}',
    '.gbx-qs button{width:2rem;height:2rem;border:0;background:transparent;color:var(--gbx-cream);font:700 1rem Arial;cursor:pointer}',
    '.gbx-qs button:active{background:rgba(218,153,0,.2)}',
    '.gbx-qs input{width:2.4rem;height:2rem;border:0;background:transparent;color:var(--gbx-cream);text-align:center;font:600 .9rem Arial;-moz-appearance:textfield}',
    '.gbx-qs input::-webkit-outer-spin-button,.gbx-qs input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}',
    '.gbx-line{font-weight:700;font-size:.95rem;white-space:nowrap}',
    '.gbx-rm{background:none;border:0;color:var(--gbx-mute);cursor:pointer;padding:.3rem;margin-left:.2rem}.gbx-rm:hover{color:#e57373}',
    '.gbx-h{font:700 .72rem Arial;letter-spacing:.09em;text-transform:uppercase;color:var(--gbx-mute);margin:1.2rem 0 .55rem}',
    '.gbx-deliv{display:grid;grid-template-columns:1fr 1fr;gap:.55rem}',
    '.gbx-opt{border:1.5px solid rgba(250,246,236,.14);border-radius:10px;padding:.7rem .7rem .65rem;cursor:pointer;background:var(--gbx-card);color:var(--gbx-cream);text-align:left;font-family:inherit}',
    '.gbx-opt svg{color:var(--gbx-gold)}.gbx-opt strong{display:block;font-size:.88rem;margin:.3rem 0 .1rem}.gbx-opt span{font-size:.74rem;color:var(--gbx-mute);line-height:1.3;display:block}',
    '.gbx-opt.on{border-color:var(--gbx-gold);background:rgba(218,153,0,.1);box-shadow:0 0 0 3px rgba(218,153,0,.12)}',
    '.gbx-code{display:flex;gap:.5rem}',
    '.gbx-code input{flex:1;min-width:0;background:var(--gbx-card);border:1px solid rgba(250,246,236,.16);border-radius:8px;color:var(--gbx-cream);padding:.6rem .7rem;font:600 .9rem Arial;text-transform:uppercase;letter-spacing:.05em}',
    '.gbx-code button{background:transparent;border:1px solid var(--gbx-gold);color:var(--gbx-gold2);border-radius:8px;padding:0 .9rem;font:700 .85rem Arial;cursor:pointer}',
    '.gbx-codeok{display:flex;justify-content:space-between;align-items:center;background:rgba(46,125,50,.15);border:1px solid rgba(102,187,106,.4);border-radius:8px;padding:.55rem .75rem;font-size:.85rem;color:#a5d6a7}',
    '.gbx-codeok button{background:none;border:0;color:var(--gbx-mute);text-decoration:underline;cursor:pointer;font-size:.78rem}',
    '.gbx-msg{font-size:.78rem;margin-top:.35rem;color:#ef9a9a}',
    '.gbx-sum{font-size:.88rem}.gbx-sum div{display:flex;justify-content:space-between;padding:.18rem 0;color:var(--gbx-mute)}',
    '.gbx-sum .disc{color:#a5d6a7}.gbx-sum .tot{color:var(--gbx-cream);font-size:1.1rem;font-weight:700;padding-top:.5rem;margin-top:.35rem;border-top:1px solid rgba(250,246,236,.1)}',
    '.gbx-go{display:flex;align-items:center;justify-content:center;gap:.5rem;width:100%;margin-top:.85rem;padding:1rem;border:0;border-radius:10px;background:linear-gradient(180deg,#f0b21a,var(--gbx-gold));color:#1a1611;font:800 1.05rem Arial;cursor:pointer;box-shadow:0 6px 18px rgba(218,153,0,.3)}',
    '.gbx-go:hover{filter:brightness(1.07)}.gbx-go:disabled{opacity:.6;cursor:default}',
    '.gbx-trust{display:flex;justify-content:center;flex-wrap:wrap;gap:.35rem .9rem;margin-top:.7rem;font-size:.72rem;color:var(--gbx-mute)}',
    '.gbx-trust span{display:inline-flex;align-items:center;gap:.25rem}.gbx-trust svg{color:var(--gbx-gold)}',
    '.gbx-pay{display:flex;justify-content:center;gap:.35rem;margin-top:.55rem}',
    '.gbx-pay span{border:1px solid rgba(250,246,236,.18);border-radius:5px;padding:.15rem .45rem;font:700 .66rem Arial;color:var(--gbx-cream);letter-spacing:.02em}',
    '.gbx-help{text-align:center;font-size:.76rem;color:var(--gbx-mute);margin-top:.6rem}.gbx-help a{color:var(--gbx-gold2)}',
    '.gbx-err{color:#ef9a9a;font-size:.84rem;margin-top:.5rem;text-align:center}',
    '.gbx-empty{text-align:center;padding:3rem 1rem}.gbx-empty .ic{width:64px;height:64px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--gbx-card);border:1px solid var(--gbx-line);color:var(--gbx-gold)}',
    '.gbx-empty p{color:var(--gbx-mute);font-size:.92rem;margin:.9rem 0 1.2rem}',
    '.gbx-empty a{display:inline-block;background:var(--gbx-gold);color:#1a1611;font-weight:800;text-decoration:none;padding:.75rem 1.4rem;border-radius:10px}',
    '.gbx-skel{height:70px;border-radius:10px;background:linear-gradient(90deg,#1f1910,#2a2216,#1f1910);background-size:200% 100%;animation:gbxSk 1.2s infinite;margin:1rem 0}@keyframes gbxSk{to{background-position:-200% 0}}',
    /* toast + sticky bar */
    '.gbx-toast{pointer-events:none;position:fixed;left:50%;bottom:5.2rem;max-width:90vw;transform:translate(-50%,150%);background:#1f1910;color:var(--gbx-cream);border:1px solid var(--gbx-gold);border-radius:999px;padding:.6rem 1rem;font:600 .88rem Arial;z-index:2001;display:flex;align-items:center;gap:.5rem;box-shadow:0 8px 24px rgba(0,0,0,.4);transition:transform .3s,opacity .3s;opacity:0;visibility:hidden}',
    '.gbx-toast.show{transform:translate(-50%,0);opacity:1;visibility:visible}body.gbx-noscroll .gbx-toast{display:none}.gbx-toast svg{color:#81c784}',
    '.gbx-sticky{position:fixed;left:0;right:0;bottom:0;z-index:1500;padding:.6rem .9rem calc(.6rem + env(safe-area-inset-bottom));background:rgba(21,17,10,.96);backdrop-filter:blur(8px);border-top:1px solid var(--gbx-line);display:none;align-items:center;justify-content:space-between;gap:.7rem;font-family:Arial,sans-serif}',
    '.gbx-sticky.on{display:flex}.gbx-sticky span{color:var(--gbx-cream);font-size:.86rem}.gbx-sticky b{color:var(--gbx-gold2)}',
    '.gbx-sticky button{background:var(--gbx-gold);color:#1a1611;border:0;border-radius:9px;padding:.7rem 1.1rem;font:800 .92rem Arial;cursor:pointer}',
    '@media(min-width:900px){.gbx-sticky{display:none!important}.gbx-toast{bottom:1.2rem}}',
    '.gbx-alt{display:block;width:100%;margin-top:.55rem;padding:.8rem;border:1.5px solid var(--gbx-gold);border-radius:10px;background:transparent;color:var(--gbx-gold2);font:700 .95rem Arial;cursor:pointer}',
    '.gbx-alt small{display:block;font:400 .74rem Arial;color:var(--gbx-mute);margin-top:.15rem}',
    '.gbx-or{text-align:center;font-size:.72rem;color:var(--gbx-mute);margin:.6rem 0 0;letter-spacing:.08em}',
    '.gbx-form label{display:block;font:700 .74rem Arial;letter-spacing:.06em;text-transform:uppercase;color:var(--gbx-mute);margin:1rem 0 .35rem}',
    '.gbx-form input,.gbx-form select,.gbx-form textarea{width:100%;box-sizing:border-box;background:var(--gbx-card);border:1px solid rgba(250,246,236,.16);border-radius:8px;color:var(--gbx-cream);padding:.7rem .75rem;font:500 .95rem Arial}',
    '.gbx-form textarea{min-height:64px;resize:vertical}',
    '.gbx-form .opt{text-transform:none;letter-spacing:0;font-weight:400}',
    '.gbx-recap{margin-top:1rem;padding:.75rem .85rem;border:1px solid var(--gbx-line);border-radius:10px;background:var(--gbx-card);font-size:.84rem;line-height:1.5}',
    '.gbx-recap b{color:var(--gbx-gold2)}',
    '.gbx-back{background:none;border:0;color:var(--gbx-mute);font:600 .85rem Arial;cursor:pointer;padding:.9rem 0 0}',
    '.gbx-done{text-align:center;padding:2.5rem .5rem}.gbx-done .ic{width:68px;height:68px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:rgba(46,125,50,.2);color:#81c784}',
    '.gbx-done .ic svg{width:34px;height:34px}.gbx-done h4{font:700 1.3rem Georgia,serif;color:var(--gbx-gold2);margin:1rem 0 .5rem}.gbx-done p{color:var(--gbx-mute);font-size:.92rem;line-height:1.5}',
    'body.gbx-noscroll{overflow:hidden}'
  ].join('\n');
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  // ---------- header button ----------
  var cartBtn = document.createElement('button');
  cartBtn.type = 'button'; cartBtn.className = 'gb-cart-btn'; cartBtn.setAttribute('aria-label', 'Open cart');
  cartBtn.innerHTML = ICON.bag + '<span>Cart</span><span class="gb-cart-count" id="gbCartCount">0</span>';
  var navEl = document.querySelector('header nav'), header = document.querySelector('header');
  if (navEl) navEl.appendChild(cartBtn); else if (header) header.appendChild(cartBtn);

  var overlay = document.createElement('div'); overlay.className = 'gb-cart-overlay'; overlay.hidden = true; document.body.appendChild(overlay);
  var drawer = document.createElement('aside'); drawer.className = 'gb-cart-drawer'; drawer.hidden = true;
  drawer.setAttribute('role', 'dialog'); drawer.setAttribute('aria-label', 'Your cart'); document.body.appendChild(drawer);
  var toast = document.createElement('div'); toast.className = 'gbx-toast'; document.body.appendChild(toast);
  var sticky = document.createElement('div'); sticky.className = 'gbx-sticky'; document.body.appendChild(sticky);

  var tickT = null;
  function openDrawer() {
    if (view !== 'done') renderDrawer(true); drawer.hidden = false; overlay.hidden = false; document.body.classList.add('gbx-noscroll');
    requestAnimationFrame(function () { drawer.classList.add('open'); overlay.classList.add('open'); });
    clearInterval(tickT); tickT = setInterval(tick, 30000);
  }
  function closeDrawer() {
    drawer.classList.remove('open'); overlay.classList.remove('open'); document.body.classList.remove('gbx-noscroll');
    setTimeout(function () { drawer.hidden = true; overlay.hidden = true; }, 280);
    clearInterval(tickT); if (view === 'done') view = 'cart';
  }
  cartBtn.addEventListener('click', openDrawer);
  overlay.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !drawer.hidden) closeDrawer(); });
  function tick() { var l = rd(LOCK_KEY, null); if (!isLockValid(l, totalQtyOf(getCart()))) renderDrawer(); else { var el = document.getElementById('gbxLeft'); if (el && l.until) el.textContent = left(l.until); } }

  function renderBadge() {
    var cart = getCart(), n = cart.reduce(function (s, i) { return s + i.quantity; }, 0);
    var el = document.getElementById('gbCartCount'); if (el) el.textContent = n;
    cartBtn.classList.toggle('has-items', n > 0);
    if (n > 0) {
      sticky.innerHTML = '<span><b>' + n + '</b> item' + (n === 1 ? '' : 's') + ' in your cart</span><button type="button">View Cart &amp; Checkout</button>';
      sticky.querySelector('button').onclick = openDrawer; sticky.classList.add('on');
    } else sticky.classList.remove('on');
  }
  function showToast(msg) {
    toast.innerHTML = ICON.check + '<span>' + esc(msg) + '</span>';
    toast.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(function () { toast.classList.remove('show'); }, 2200);
  }

  // ---------- drawer ----------
  var codeMsg = '';
  var view = 'cart';
  function renderDrawer(force) {
    if (view !== 'cart' && !force) return;
    view = 'cart';
    var cart = getCart();
    var head = '<div class="gbx-head"><h3>' + ICON.bag + ' Your Cart' + (cart.length ? ' <small>(' + cart.reduce(function (s, i) { return s + i.quantity; }, 0) + ')</small>' : '') + '</h3><button type="button" class="gbx-x" aria-label="Close">&times;</button></div>';
    function bindClose() { drawer.querySelector('.gbx-x').onclick = closeDrawer; }

    if (!cart.length) {
      drawer.innerHTML = head + '<div class="gbx-body"><div class="gbx-empty"><div class="ic">' + ICON.bag + '</div><p>Your cart is empty.<br>Pick a series to get started.</p><a href="/#series">Browse Goldbacks</a></div></div>';
      bindClose(); drawer.querySelector('.gbx-empty a').onclick = closeDrawer; return;
    }
    if (!drawer.querySelector('.gbx-item')) { drawer.innerHTML = head + '<div class="gbx-body"><div class="gbx-skel"></div><div class="gbx-skel"></div></div>'; bindClose(); }

    var tq = totalQtyOf(cart);
    ensureLock(tq, function (lock) {
      if (!lock) {
        drawer.innerHTML = head + '<div class="gbx-body"><div class="gbx-empty"><p>We couldn\'t load today\'s price.<br>Please try again, or call us at <a href="' + PHONE_HREF + '" style="background:none;color:#FDDD3B;padding:0">' + PHONE + '</a>.</p></div></div>';
        bindClose(); return;
      }
      var code = getCode(), deliv = getDelivery();
      var base = lock.priceCents, price = effPrice(lock, code);
      var sub = 0, full = 0;
      var items = cart.map(function (it, i) {
        var unitFull = Math.round(it.faceValueGB * base), unit = Math.round(it.faceValueGB * price);
        full += unitFull * it.quantity; sub += unit * it.quantity;
        var thumb = it.img ? '<img class="gbx-thumb" src="' + esc(it.img) + '" alt="">' : '<div class="gbx-thumb ph">' + esc(it.faceValueGB) + '</div>';
        return '<div class="gbx-item">' + thumb + '<div class="gbx-info"><div class="gbx-name">' + esc(it.series) + ' ' + esc(it.denomination) + '</div>' +
          '<div class="gbx-sub">24k gold Goldback &middot; ' + usd(unit) + ' each</div>' +
          '<div class="gbx-row2"><div class="gbx-qs"><button type="button" data-a="dec" data-i="' + i + '" aria-label="Less">&minus;</button><input type="number" inputmode="numeric" min="0" max="999" value="' + it.quantity + '" data-i="' + i + '" aria-label="Quantity"><button type="button" data-a="inc" data-i="' + i + '" aria-label="More">+</button></div>' +
          '<div><span class="gbx-line">' + usd(unit * it.quantity) + '</span><button type="button" class="gbx-rm" data-i="' + i + '" aria-label="Remove">' + ICON.trash + '</button></div></div></div></div>';
      }).join('');
      var discount = full - sub;
      var ship = deliv === 'pickup' ? 0 : (sub >= FREE_SHIP_CENTS ? 0 : SHIP_CENTS);

      // Progress toward Goldback's daily rate ($2,000+ orders)
      var prog = '';
      if (lock.dailyCents) {
        var U = Math.ceil(200000 / lock.dailyCents);
        if (tq >= U) prog = '<div class="gbx-prog">' + ICON.check + ' <b>Daily rate unlocked.</b> Your whole order is at Goldback\'s daily rate, ' + usd(lock.dailyCents) + ' per Goldback.<div class="gbx-bar"><i style="width:100%"></i></div></div>';
        else {
          var need = Math.ceil(U - tq), pct = Math.max(4, Math.min(100, Math.round(tq / U * 100)));
          prog = '<div class="gbx-prog">Add <b>' + need + ' more Goldback' + (need === 1 ? '' : 's') + '</b> to unlock Goldback\'s daily rate (' + usd(lock.dailyCents) + ' each) on your whole order.<div class="gbx-bar"><i style="width:' + pct + '%"></i></div></div>';
        }
      }
      var lockHtml = lock.until ? '<div class="gbx-lock">' + ICON.lock + '<div>Today\'s price is held until <b>' + untilLabel(lock.until) + '</b> (<span id="gbxLeft">' + left(lock.until) + '</span> left). After that it moves with gold.</div></div>' : '';

      var deliveryHtml = '<div class="gbx-h">Delivery</div><div class="gbx-deliv">' +
        '<button type="button" class="gbx-opt' + (deliv === 'ship' ? ' on' : '') + '" data-d="ship">' + ICON.truck + '<strong>Ship to me</strong><span>' + (sub >= FREE_SHIP_CENTS ? 'Free, insured' : usd(SHIP_CENTS) + ' &middot; free over ' + usd(FREE_SHIP_CENTS)) + '<br>2&ndash;6 business days</span></button>' +
        '<button type="button" class="gbx-opt' + (deliv === 'pickup' ? ' on' : '') + '" data-d="pickup">' + ICON.pin + '<strong>Local pickup</strong><span>Free &middot; San Diego<br>We text you a time</span></button></div>';

      var codeHtml = '<div class="gbx-h">Scratch &amp; Win code</div>' + (code
        ? '<div class="gbx-codeok"><span>' + ICON.check + ' <b>' + esc(code.code) + '</b> &middot; ' + (code.discount_bps / 100) + '% off</span><button type="button" id="gbxCodeRm">Remove</button></div>'
        : '<div class="gbx-code"><input id="gbxCode" placeholder="Enter code" autocomplete="off" autocapitalize="characters"><button type="button" id="gbxCodeAp">Apply</button></div>') +
        (codeMsg ? '<div class="gbx-msg">' + esc(codeMsg) + '</div>' : '');

      var body = '<div class="gbx-body">' + lockHtml + prog + '<div>' + items + '</div>' + deliveryHtml + codeHtml + '<div style="height:1rem"></div></div>';
      var foot = '<div class="gbx-foot"><div class="gbx-sum">' +
        '<div><span>Subtotal</span><span>' + usd(full) + '</span></div>' +
        (discount > 0 ? '<div class="disc"><span>Code ' + esc(code.code) + '</span><span>&minus;' + usd(discount) + '</span></div>' : '') +
        '<div><span>' + (deliv === 'pickup' ? 'Local pickup' : 'Shipping') + '</span><span>' + (ship ? usd(ship) : 'FREE') + '</span></div>' +
        '<div><span>Sales tax</span><span>At checkout</span></div>' +
        '<div class="tot"><span>Estimated total</span><span>' + usd(sub + ship) + '</span></div></div>' +
        '<button type="button" class="gbx-go" id="gbCartCheckoutBtn">' + ICON.lock + ' Secure Checkout</button>' +
        '<div class="gbx-err" id="gbCartError" hidden></div>' +
        '<button type="button" class="gbx-alt" id="gbxReserve">Reserve now, pay at pickup<small>No card needed. We text you to set a time in San Diego.</small></button>' +
        '<div class="gbx-pay"><span>VISA</span><span>Mastercard</span><span>AMEX</span><span>Apple Pay</span><span>Google Pay</span></div>' +
        '<div class="gbx-trust"><span>' + ICON.shield + ' Secured by Stripe</span><span>' + ICON.check + ' Official Goldback distributor</span></div>' +
        '<div class="gbx-help">Questions? Call or text <a href="' + PHONE_HREF + '">' + PHONE + '</a></div></div>';

      var y = (drawer.querySelector('.gbx-body') || {}).scrollTop || 0;
      drawer.innerHTML = head + body + foot;
      drawer.querySelector('.gbx-body').scrollTop = y;
      bindClose();

      drawer.querySelectorAll('.gbx-qs button').forEach(function (b) {
        b.onclick = function () { var i = +b.dataset.i, c = getCart(); updateQty(i, c[i].quantity + (b.dataset.a === 'inc' ? 1 : -1)); };
      });
      drawer.querySelectorAll('.gbx-qs input').forEach(function (inp) { inp.onchange = function () { updateQty(+inp.dataset.i, parseInt(inp.value, 10) || 0); }; });
      drawer.querySelectorAll('.gbx-rm').forEach(function (b) { b.onclick = function () { updateQty(+b.dataset.i, 0); }; });
      drawer.querySelectorAll('.gbx-opt').forEach(function (b) { b.onclick = function () { wr(DELIV_KEY, b.dataset.d); renderDrawer(); }; });
      var ap = document.getElementById('gbxCodeAp');
      if (ap) {
        var inp = document.getElementById('gbxCode');
        inp.onkeydown = function (e) { if (e.key === 'Enter') ap.click(); };
        ap.onclick = function () {
          var v = (inp.value || '').trim().toUpperCase(); if (!v) return;
          ap.disabled = true; ap.textContent = '…';
          fetch('/api/discount-check?code=' + encodeURIComponent(v)).then(function (r) { return r.json(); }).then(function (d) {
            if (d.ok) { wr(CODE_KEY, { code: d.code, discount_bps: d.discount_bps, expires_at: d.expires_at }); codeMsg = ''; }
            else codeMsg = d.error || 'That code isn\'t valid.';
            renderDrawer();
          }).catch(function () { codeMsg = 'Couldn\'t check that code. Try again.'; renderDrawer(); });
        };
      }
      var rm = document.getElementById('gbxCodeRm'); if (rm) rm.onclick = function () { wr(CODE_KEY, null); renderDrawer(); };
      document.getElementById('gbCartCheckoutBtn').onclick = doCheckout;
      document.getElementById('gbxReserve').onclick = function () { renderReserve(cart, tq, sub, code); };
    });
  }

  function renderReserve(cart, tq, sub, code) {
    view = 'reserve';
    var list = cart.map(function (i) { return i.quantity + ' &times; ' + esc(i.series) + ' ' + esc(i.denomination); }).join('<br>');
    drawer.innerHTML = '<div class="gbx-head"><h3>' + ICON.pin + ' Reserve for pickup</h3><button type="button" class="gbx-x" aria-label="Close">&times;</button></div>' +
      '<div class="gbx-body"><button type="button" class="gbx-back" id="gbxBack">&lsaquo; Back to cart</button>' +
      '<div class="gbx-recap">' + list + '<br><b>Estimated total ' + usd(sub) + '</b> plus sales tax, paid at pickup.</div>' +
      '<form class="gbx-form" id="gbxRF" novalidate>' +
      '<label for="gbxRN">Your name</label><input id="gbxRN" autocomplete="name" required>' +
      '<label for="gbxRP">Mobile number</label><input id="gbxRP" type="tel" autocomplete="tel" inputmode="tel" placeholder="(619) 555-0123" required>' +
      '<label for="gbxRE">Email <span class="opt">(optional)</span></label><input id="gbxRE" type="email" autocomplete="email">' +
      '<label for="gbxRT">Best time to pick up</label><select id="gbxRT"><option>As soon as possible</option><option>Today</option><option>Tomorrow</option><option>This weekend</option><option>Next week</option><option>Just call me to set it up</option></select>' +
      '<label for="gbxRM">Anything else? <span class="opt">(optional)</span></label><textarea id="gbxRM" placeholder="Questions, special requests..."></textarea>' +
      '<input type="text" id="gbxHp" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">' +
      '</form><div style="height:1rem"></div></div>' +
      '<div class="gbx-foot"><button type="button" class="gbx-go" id="gbxRGo">' + ICON.check + ' Reserve My Goldbacks</button><div class="gbx-err" id="gbxRErr" hidden></div>' +
      '<div class="gbx-help">Nothing is charged now. Questions? <a href="' + PHONE_HREF + '">' + PHONE + '</a></div></div>';
    drawer.querySelector('.gbx-x').onclick = closeDrawer;
    document.getElementById('gbxBack').onclick = function () { renderDrawer(true); };
    var go = document.getElementById('gbxRGo'), er = document.getElementById('gbxRErr');
    go.onclick = function () {
      var name = document.getElementById('gbxRN').value.trim(), phone = document.getElementById('gbxRP').value.trim();
      if (!name || phone.replace(/\D/g, '').length < 10) { er.textContent = 'Please add your name and a 10-digit mobile number.'; er.hidden = false; return; }
      go.disabled = true; go.textContent = 'Reserving…'; er.hidden = true;
      fetch('/api/reserve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        name: name, phone: phone, email: document.getElementById('gbxRE').value.trim(), when: document.getElementById('gbxRT').value,
        note: document.getElementById('gbxRM').value.trim(), company: document.getElementById('gbxHp').value, code: code ? code.code : null,
        items: cart.map(function (i) { return { series: i.series, denomination: i.denomination, faceValueGB: i.faceValueGB, quantity: i.quantity }; })
      }) }).then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) throw new Error(d.error || 'Could not reserve.');
        wr(CART_KEY, null); wr(LOCK_KEY, null); wr(CODE_KEY, null); setCart([]); view = 'done';
        drawer.innerHTML = '<div class="gbx-head"><h3>' + ICON.check + ' Reserved</h3><button type="button" class="gbx-x" aria-label="Close">&times;</button></div>' +
          '<div class="gbx-body"><div class="gbx-done"><div class="ic">' + ICON.check + '</div><h4>You\'re all set, ' + esc(name.split(' ')[0]) + '!</h4>' +
          '<p>Your Goldbacks are set aside. Art will text you at <b style="color:#FAF6EC">' + esc(phone) + '</b> to set your pickup time and confirm your total.</p>' +
          '<p>You pay when you pick up. Nothing was charged.</p></div></div>';
        drawer.querySelector('.gbx-x').onclick = closeDrawer;
      }).catch(function (e) { go.disabled = false; go.innerHTML = ICON.check + ' Reserve My Goldbacks'; er.textContent = (e.message || 'Could not reserve.') + ' Or call ' + PHONE + '.'; er.hidden = false; });
    };
  }

  function doCheckout() {
    var cart = getCart(); if (!cart.length) return;
    var btn = document.getElementById('gbCartCheckoutBtn'), err = document.getElementById('gbCartError');
    btn.disabled = true; btn.innerHTML = ICON.lock + ' Opening secure checkout…'; err.hidden = true;
    var code = getCode();
    fetch('/api/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: cart.map(function (i) { return { series: i.series, denomination: i.denomination, faceValueGB: i.faceValueGB, quantity: i.quantity }; }),
        delivery: getDelivery(), code: code ? code.code : null
      })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok && d.url) { wr(CART_KEY, null); wr(LOCK_KEY, null); wr(CODE_KEY, null); location.href = d.url; return; }
      throw new Error(d.error || 'Could not start checkout.');
    }).catch(function (e) {
      btn.disabled = false; btn.innerHTML = ICON.lock + ' Secure Checkout';
      err.textContent = (e.message || 'Could not start checkout.') + ' Or call ' + PHONE + '.'; err.hidden = false;
    });
  }

  // ---------- product cards: stepper + add to cart ----------
  document.querySelectorAll('.buy-row').forEach(function (row) {
    var qty = row.querySelector('.buy-qty'), btn = row.querySelector('.buy-btn');
    if (!qty || !btn) return;
    row.classList.add('gbx-row');
    var stp = document.createElement('div'); stp.className = 'gbx-step';
    stp.innerHTML = '<button type="button" aria-label="Less">&minus;</button>';
    qty.parentNode.insertBefore(stp, qty); stp.appendChild(qty);
    stp.insertAdjacentHTML('beforeend', '<button type="button" aria-label="More">+</button>');
    qty.setAttribute('inputmode', 'numeric');
    var bs = stp.querySelectorAll('button');
    bs[0].onclick = function () { qty.value = Math.max(1, (parseInt(qty.value, 10) || 1) - 1); };
    bs[1].onclick = function () { qty.value = Math.min(999, (parseInt(qty.value, 10) || 1) + 1); };
    btn.innerHTML = ICON.bag + ' Add to Cart';
  });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.buy-btn'); if (!btn) return;
    var row = btn.closest('.buy-row'), qtyInput = row.querySelector('.buy-qty');
    var q = Math.max(1, Math.min(999, parseInt(qtyInput.value, 10) || 1));
    var card = row.closest('.denom-card'), img = card && card.querySelector('img');
    addToCart({ series: row.dataset.series, denomination: row.dataset.denomination, faceValueGB: parseFloat(row.dataset.faceValue), quantity: q, img: img ? img.getAttribute('src') : null });
    btn.classList.add('gbx-added'); btn.innerHTML = ICON.check + ' Added';
    setTimeout(function () { btn.classList.remove('gbx-added'); btn.innerHTML = ICON.bag + ' Add to Cart'; }, 1400);
    qtyInput.value = 1;
    cartBtn.classList.remove('bump'); void cartBtn.offsetWidth; cartBtn.classList.add('bump');
    showToast(q + ' × ' + row.dataset.series + ' ' + row.dataset.denomination.replace(/&frac14;/, '¼') + ' added');
    if (window.matchMedia('(min-width: 900px)').matches) openDrawer();
  });

  window.GBCart = { get: getCart, setQty: setQtyFor, open: openDrawer, onChange: function (f) { listeners.push(f); } };

  if (/[?&]cart=open/.test(location.search)) setTimeout(openDrawer, 300);
  renderBadge();
})();
