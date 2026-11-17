/* Bundle builder sheet.

   Opened by the "Build a bundle" button in the Bundle & save block. The
   shopper picks pieces into a bundle list; nothing reaches the cart until the
   footer button, which adds every line in one /cart/add.js request, closes
   the sheet and opens the cart drawer.

   The numbers (agreed with the merchant, 2026-10-02):
   - The automatic discount applies to every product, cart-wide, by item
     count. Count = quantities already in the cart + one per bundle line.
   - Free shipping is a $0 shipping rate on order price, which Shopify measures
     after discounts, so the threshold is checked against (cart + bundle) with
     the tier percentage taken off.
   - The sheet only previews the discount; checkout applies the real one.

   Products come from two theme views, ?view=bundle-json on a collection (the
   chips) and on /search (typing), 24 a page, sold-out already removed. */

(() => {
  if (window.CAU && window.CAU.bundleSheet) return;

  const configEl = document.querySelector('[data-pdp-bundle-config]');
  const templateEl = document.querySelector('[data-pdp-bundle-template]');
  if (!configEl || !templateEl) return;

  let cfg;
  try {
    cfg = JSON.parse(configEl.textContent);
  } catch (error) {
    return;
  }

  const routes = (window.themeVariables && window.themeVariables.routes) || {};
  const CART_URL = routes.cartUrl || '/cart';
  const CART_ADD_URL = routes.cartAddUrl || '/cart/add';
  const MONEY_FORMAT = (window.themeVariables && window.themeVariables.settings && window.themeVariables.settings.moneyFormat) || '${{amount}}';
  const tiers = (cfg.tiers || []).slice().sort((a, b) => a.items - b.items);

  /* ---------- helpers ---------- */

  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function money(cents) {
    const value = Math.round(cents) / 100;
    const withDelimiters = (amount, decimals, thousands, decimal) => {
      const [whole, fraction] = amount.toFixed(decimals).split('.');
      return whole.replace(/\B(?=(\d{3})+(?!\d))/g, thousands) + (fraction ? decimal + fraction : '');
    };
    return MONEY_FORMAT.replace(/\{\{\s*(\w+)\s*\}\}/, (match, key) => {
      switch (key) {
        case 'amount_no_decimals': return withDelimiters(value, 0, ',', '.');
        case 'amount_with_comma_separator': return withDelimiters(value, 2, '.', ',');
        case 'amount_no_decimals_with_comma_separator': return withDelimiters(value, 0, '.', ',');
        default: return withDelimiters(value, 2, ',', '.');
      }
    });
  }

  const available = (product) => product.variants.filter((v) => v.available);
  const needsSize = (product) => !product.single && product.variants.length > 1;
  const variantOf = (product, id) => product.variants.find((v) => v.id === id) || null;
  const fromPrice = (product) => {
    const list = available(product);
    return list.length ? list.reduce((low, v) => (v.price < low.price ? v : low), list[0]) : product.variants[0];
  };
  const linePrice = (line) => (line.variantId ? variantOf(line.product, line.variantId).price : fromPrice(line.product).price);

  /* One ladder, read two ways (settings.bundle_discount_type): the second
     number in each tier is a percentage, or an amount off every item. Only the
     preview changes - checkout applies Shopify's own discount either way. */
  const byAmount = cfg.discountType === 'amount';
  const tierFor = (count) => tiers.reduce((hit, t) => (count >= t.items ? t : hit), null);
  const tierLabel = (tier) => (byAmount ? `${money(tier.amt)} off each` : `${tier.pct}% off`);
  const cutFor = (count, base) => {
    const tier = tierFor(count);
    if (!tier) return 0;
    // An amount off each cannot take the bundle below zero.
    return byAmount ? Math.min(base, tier.amt * count) : Math.round(base * tier.pct / 100);
  };
  const pctFor = (count) => tiers.reduce((pct, t) => (count >= t.items ? t.pct : pct), 0);
  const nextTier = (count) => tiers.find((t) => t.items > count) || null;

  /* ---------- state ---------- */

  const state = {
    cart: { items: [], original_total_price: 0 },
    draft: [],            // { product, variantId, self, editing }
    expanded: null,       // product id whose size chips are open in the results
    chip: 0,
    query: '',
    list: [],
    page: 0,
    pages: 0,
    source: null,         // url of the current list, without page
    loading: false,
    request: 0,
    opener: null,
    busy: false
  };

  let root, els;
  let CLOSE_ICON = '';   // Focal's close icon, lifted from the sheet's own close button

  /* ---------- mount ---------- */

  function mount() {
    if (root) return;
    root = templateEl.content.firstElementChild.cloneNode(true);
    document.body.appendChild(root);
    // The chip rail only becomes a real element here, so it needs its own pass.
    if (window.CAU && window.CAU.dragScroll) window.CAU.dragScroll.scan();
    const q = (name) => root.querySelector(`[data-pdp-bb-${name}]`);
    els = {
      sheet: root.querySelector('.pdp-bb__sheet'),
      title: root.querySelector('.pdp-bb__title'),
      msg: q('msg'), meter: q('meter'), fill: q('fill'), nodes: q('nodes'),
      body: q('body'), count: q('count'), picked: q('picked'),
      search: q('search'), clear: q('clear'), chips: q('chips'),
      results: q('results'), empty: q('empty'), more: q('more'),
      items: q('items'), was: q('was'), total: q('total'), save: q('save'),
      error: q('error'), add: q('add')
    };

    CLOSE_ICON = root.querySelector('.pdp-bb__close').innerHTML;

    root.addEventListener('click', onClick);
    // On the document, not the sheet: a click on blank space inside the sheet
    // drops focus to <body>, and Escape must still close it.
    document.addEventListener('keydown', (event) => {
      if (root && !root.hidden) onKeydown(event);
    });
    els.search.addEventListener('input', onSearchInput);
    els.search.addEventListener('keydown', (event) => { if (event.key === 'Enter') event.preventDefault(); });

    renderChips();

    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      }, { root: els.body, rootMargin: '200px' }).observe(els.more);
    }
  }

  /* ---------- open / close ---------- */

  async function open(opener) {
    mount();
    state.opener = opener || document.activeElement;
    els.error.hidden = true;

    await refreshCart();
    seedSelf();
    if (!state.source) selectChip(0);

    render();
    root.hidden = false;
    document.documentElement.classList.add('pdp-bb-lock');
    requestAnimationFrame(() => root.classList.add('is-open'));
    els.body.scrollTop = 0;
    els.title.focus({ preventScroll: true });
  }

  function close() {
    if (!root || root.hidden) return;
    root.classList.remove('is-open');
    document.documentElement.classList.remove('pdp-bb-lock');
    state.expanded = null;
    state.draft.forEach((line) => { line.editing = false; });
    if (state.query || state.chip !== 0) {
      state.query = '';
      els.search.value = '';
      els.clear.hidden = true;
      state.source = null;
    }
    const done = () => { root.hidden = true; };
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) done(); else setTimeout(done, 260);
    if (state.opener && state.opener.focus) state.opener.focus({ preventScroll: true });
  }

  /* "This item": in the bundle unless it is already in the cart, in the size
     chosen on the page, or asking for one. */
  function seedSelf() {
    const product = cfg.product;
    if (!product || !available(product).length) return;
    const inCart = state.cart.items.some((item) => item.product_id === product.id);
    const selfIndex = state.draft.findIndex((line) => line.self);
    if (inCart) {
      if (selfIndex >= 0) state.draft.splice(selfIndex, 1);
      return;
    }
    if (selfIndex >= 0 || state.draft.length) {
      if (selfIndex >= 0 && !state.draft[selfIndex].variantId) state.draft[selfIndex].variantId = pageVariant(product);
      return;
    }
    state.draft.push({ product, variantId: pageVariant(product), self: true, editing: false });
  }

  function pageVariant(product) {
    if (!needsSize(product)) return available(product)[0].id;
    const chosen = window.CAU && window.CAU.allSizesChosen ? window.CAU.allSizesChosen() : true;
    if (!chosen) return null;
    const input = document.querySelector('.pdp-v2 form[is="product-form"] input[name="id"]');
    const id = input ? Number(input.value) : null;
    const variant = id ? variantOf(product, id) : null;
    return variant && variant.available ? variant.id : null;
  }

  async function refreshCart() {
    try {
      const response = await fetch(`${CART_URL}.js`, { headers: { Accept: 'application/json' } });
      if (response.ok) state.cart = await response.json();
    } catch (error) { /* keep the last cart we had */ }
  }

  /* ---------- the numbers ---------- */

  function totals() {
    // Shipping protection is a cart line but never an item: it does not count
    // toward a tier or toward free shipping.
    const counted = state.cart.items.filter((item) => item.product_id !== cfg.protectionProductId);
    const inCart = counted.reduce((n, item) => n + item.quantity, 0);
    const count = inCart + state.draft.length;
    const pct = pctFor(count);
    const bundleBase = state.draft.reduce((sum, line) => sum + linePrice(line), 0);
    const base = counted.reduce((sum, item) => sum + item.original_line_price, 0) + bundleBase;
    const after = base - cutFor(count, base);
    const bundleAfter = bundleBase - cutFor(count, bundleBase);
    return { inCart, count, pct, bundleBase, bundleAfter, after };
  }

  function milestones(t) {
    const list = [];
    if (cfg.ship > 0) {
      list.push({ title: 'Free shipping', sub: `${money(cfg.ship).replace(/\.00$/, '')}+`, done: t.count > 0 && t.after >= cfg.ship, part: Math.min(1, t.after / cfg.ship) });
    }
    tiers.forEach((tier, i) => {
      const prev = i === 0 ? 0 : tiers[i - 1].items;
      list.push({
        title: tierLabel(tier),
        sub: `${tier.items}${i === tiers.length - 1 ? '+' : ''} items`,
        done: t.count >= tier.items,
        part: Math.max(0, Math.min(1, (t.count - prev) / (tier.items - prev)))
      });
    });
    return list;
  }

  /* ---------- render ---------- */

  function render() {
    keepFocus(() => {
      renderProgress();
      renderPicked();
      renderResults();
      renderFoot();
    });
  }

  function renderProgress() {
    const t = totals();
    const nodes = milestones(t);

    const parts = [];
    if (cfg.ship > 0) {
      parts.push(t.count > 0 && t.after >= cfg.ship ? 'Free shipping unlocked' : `<b>${money(cfg.ship - t.after)}</b> from free shipping`);
    }
    const next = nextTier(t.count);
    if (next) {
      const need = next.items - t.count;
      parts.push(`<b>${plural(need, 'more item')}</b> for ${tierLabel(next)}`);
    } else if (tiers.length) {
      const reached = tierFor(t.count);
      if (reached) parts.push(`You've unlocked <b>${tierLabel(reached)}</b>`);
    }
    els.msg.innerHTML = parts.join(' · ') + (t.inCart ? `<small>Includes ${plural(t.inCart, 'item')} already in your bag</small>` : '');

    // Fill to the furthest milestone reached, then part of the way to the next.
    const n = nodes.length;
    const pos = (i) => (i < 0 ? 0 : (i + 1) / n);
    let last = -1;
    nodes.forEach((node, i) => { if (node.done) last = i; });
    let width = pos(last);
    if (last + 1 < n) width += nodes[last + 1].part * (pos(last + 1) - pos(last));
    els.fill.style.width = `${(width * 100).toFixed(2)}%`;

    els.nodes.innerHTML = nodes.map((node, i) => `
      <li class="pdp-bb__node${node.done ? ' is-done' : ''}" style="left:${(pos(i) * 100).toFixed(2)}%">
        <span class="pdp-bb__dot" aria-hidden="true"></span>
        <b>${esc(node.title)}</b><span>${esc(node.sub)}</span>
      </li>`).join('');
    els.meter.setAttribute('aria-label', `Bundle rewards: ${nodes.map((node) => `${node.title} ${node.done ? 'reached' : 'not reached'}`).join(', ')}`);
  }

  function sizeChips(product, selectedId, owner) {
    return `<div class="pdp-bb__sizes" role="group" aria-label="Size for ${esc(product.title)}">
      <span class="pdp-bb__hint">Select size</span>
      <div class="pdp-bb__chiplist">${product.variants.map((v) => `
        <button type="button" class="pdp-bb__size" data-size="${v.id}" data-owner="${owner}" data-focus="size-${owner}-${v.id}"
          aria-pressed="${v.id === selectedId}"${v.available ? '' : ' disabled'}>${esc(v.title)}</button>`).join('')}
      </div>
    </div>`;
  }

  function renderPicked() {
    els.count.textContent = state.draft.length ? plural(state.draft.length, 'item') : '';
    if (!state.draft.length) {
      els.picked.innerHTML = '<li class="pdp-bb__pick-empty">Search or browse below to add pieces.</li>';
      return;
    }
    els.picked.innerHTML = state.draft.map((line, i) => {
      const p = line.product;
      const variant = line.variantId ? variantOf(p, line.variantId) : null;
      const missing = needsSize(p) && !variant;
      const showSizes = missing || line.editing;
      return `<li class="pdp-bb__pick${missing ? ' is-missing' : ''}" data-line="${i}">
        ${p.image ? `<img src="${esc(p.image)}" alt="" width="48" height="48" loading="lazy">` : '<span class="pdp-bb__noimg"></span>'}
        <div class="pdp-bb__pick-main">
          <span class="pdp-bb__pick-name">${esc(p.title)}</span>
          <span class="pdp-bb__pick-meta">
            ${line.self ? '<span class="pdp-bb__tag">This item</span>' : ''}
            ${variant && needsSize(p) ? `<span>Size ${esc(variant.title)}</span>${line.editing ? '' : `<button type="button" class="pdp-bb__change" data-change="${i}" data-focus="change-${p.id}" aria-label="Change size of ${esc(p.title)}">Change</button>`}` : ''}
            ${missing ? '<span class="pdp-bb__need">Select size</span>' : ''}
            <span class="pdp-v2__tnum">${money(linePrice(line))}</span>
          </span>
        </div>
        <button type="button" class="pdp-bb__remove" data-remove="${i}" aria-label="Remove ${esc(p.title)} from bundle">${CLOSE_ICON}</button>
        ${showSizes ? sizeChips(p, line.variantId, `line-${i}`) : ''}
      </li>`;
    }).join('');
  }

  function renderResults() {
    const selfId = cfg.product ? cfg.product.id : null;
    const list = state.list.filter((p) => p.id !== selfId);
    els.results.innerHTML = list.map((p) => {
      const added = state.draft.some((line) => line.product.id === p.id);
      const open = state.expanded === p.id && !added;
      const v = fromPrice(p);
      const label = added ? '✓ Added' : (open ? 'Cancel' : '+ Add');
      return `<li class="pdp-bb__res">
        ${p.image ? `<img src="${esc(p.image)}" alt="" width="56" height="56" loading="lazy">` : '<span class="pdp-bb__noimg"></span>'}
        <div class="pdp-bb__res-main">
          <span class="pdp-bb__vendor">${esc(p.vendor)}</span>
          <span class="pdp-bb__res-name">${esc(p.title)}</span>
          <span class="pdp-bb__price pdp-v2__tnum">${money(v.price)}${v.compare > v.price ? ` <s>${money(v.compare)}</s>` : ''}</span>
        </div>
        <button type="button" class="pdp-bb__res-add" data-add="${p.id}" data-focus="add-${p.id}" aria-pressed="${added}"
          ${needsSize(p) && !added ? `aria-expanded="${open}"` : ''}
          aria-label="${added ? `Remove ${esc(p.title)} from bundle` : `Add ${esc(p.title)} to bundle`}">${label}</button>
        ${open ? sizeChips(p, null, `res-${p.id}`) : ''}
      </li>`;
    }).join('');

    let message = '';
    if (!state.source) {
      message = 'Search to find pieces.';
    } else if (!list.length && !state.loading && state.page >= 1) {
      message = state.query
        ? `No matches for “${state.query}”. Try “hoodie”, “Nike” or “tee”.`
        : 'Nothing available here right now.';
    }
    els.empty.textContent = message;
    els.empty.hidden = !message;
  }

  function renderFoot() {
    const t = totals();
    const n = state.draft.length;
    els.items.textContent = `${plural(n, 'item')} in this bundle`;
    els.total.textContent = money(t.bundleAfter);
    const saving = t.bundleBase - t.bundleAfter;
    els.was.textContent = saving > 0 && n ? money(t.bundleBase) : '';

    const reached = tierFor(t.count);
    const next = nextTier(t.count);
    const parts = [];
    if (saving > 0 && n && reached) parts.push(`You save ${money(saving)} with ${tierLabel(reached)}`);
    if (next) parts.push(`Add ${plural(next.items - t.count, 'more item')} for ${tierLabel(next)}`);
    els.save.textContent = parts.join(' · ');

    els.add.disabled = !n || state.busy;
    els.add.setAttribute('aria-busy', state.busy ? 'true' : 'false');
  }

  /* Re-rendering replaces the buttons; put focus back on the same control. */
  function keepFocus(fn) {
    const active = root && root.contains(document.activeElement) ? document.activeElement : null;
    const key = active && active.getAttribute('data-focus');
    fn();
    if (key) {
      const again = root.querySelector(`[data-focus="${CSS.escape(key)}"]`);
      if (again) again.focus({ preventScroll: true });
    }
  }

  /* ---------- list loading ---------- */

  function renderChips() {
    const chips = cfg.chips || [];
    els.chips.hidden = !chips.length;
    els.chips.innerHTML = chips.map((chip, i) => `
      <button type="button" class="pdp-bb__chip" data-chip="${i}" data-focus="chip-${i}" aria-pressed="${i === state.chip}">${esc(chip.label)}</button>`).join('');
  }

  function selectChip(index) {
    const chip = (cfg.chips || [])[index];
    state.chip = index;
    state.query = '';
    renderChips();
    if (!chip) {
      state.source = null;
      state.list = [];
      state.page = 0;
      state.pages = 0;
      return;
    }
    const url = new URL(chip.url, window.location.origin);
    url.searchParams.set('view', 'bundle-json');
    load(url.toString());
  }

  function search(query) {
    state.query = query;
    const url = new URL(cfg.searchUrl || '/search', window.location.origin);
    url.searchParams.set('q', query);
    url.searchParams.set('type', 'product');
    url.searchParams.set('options[prefix]', 'last');
    url.searchParams.set('view', 'bundle-json');
    load(url.toString());
  }

  function load(source) {
    state.source = source;
    state.list = [];
    state.page = 0;
    state.pages = 1;
    state.expanded = null;
    fetchPage(1);
  }

  function loadMore() {
    if (!state.source || state.loading || state.page >= state.pages) return;
    fetchPage(state.page + 1);
  }

  async function fetchPage(page) {
    const token = ++state.request;
    state.loading = true;
    els.more.classList.add('is-loading');
    try {
      const url = new URL(state.source);
      url.searchParams.set('page', page);
      // No "Accept: application/json" here: with it, Shopify ignores ?view=
      // and answers with its own collection JSON, which has no product list.
      const response = await fetch(url.toString());
      const data = JSON.parse(await response.text());
      if (!Array.isArray(data.products)) throw new Error('Not a bundle-json view');
      if (token !== state.request) return;
      state.list = state.list.concat(data.products || []);
      state.page = data.page || page;
      state.pages = data.pages || page;
    } catch (error) {
      if (token !== state.request) return;
      state.pages = state.page;     // stop asking for more
    } finally {
      if (token === state.request) {
        state.loading = false;
        els.more.classList.remove('is-loading');
        keepFocus(renderResults);
      }
    }
    // A short page (sold-out removed) may not fill the view; keep going.
    if (token === state.request && els.body.scrollHeight <= els.body.clientHeight + 200) loadMore();
  }

  let searchTimer;
  function onSearchInput() {
    const value = els.search.value.trim();
    els.clear.hidden = !els.search.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (value.length >= 2) {
        if (value !== state.query) search(value);
      } else if (!value && state.query) {
        selectChip(state.chip);
      }
    }, 300);
  }

  /* ---------- actions ---------- */

  function onClick(event) {
    const target = event.target.closest('button, [data-pdp-bb-close]');
    if (!target) return;

    if (target.hasAttribute('data-pdp-bb-close')) return close();
    if (target.hasAttribute('data-pdp-bb-clear')) {
      els.search.value = '';
      els.clear.hidden = true;
      selectChip(state.chip);
      els.search.focus();
      return render();
    }
    if (target.hasAttribute('data-chip')) {
      els.search.value = '';
      els.clear.hidden = true;
      selectChip(Number(target.getAttribute('data-chip')));
      return render();
    }
    if (target.hasAttribute('data-add')) return toggleProduct(Number(target.getAttribute('data-add')));
    if (target.hasAttribute('data-size')) return pickSize(target.getAttribute('data-owner'), Number(target.getAttribute('data-size')));
    if (target.hasAttribute('data-change')) {
      state.draft[Number(target.getAttribute('data-change'))].editing = true;
      return render();
    }
    if (target.hasAttribute('data-remove')) {
      state.draft.splice(Number(target.getAttribute('data-remove')), 1);
      render();
      return els.title.focus({ preventScroll: true });
    }
    if (target.hasAttribute('data-pdp-bb-add')) return addToCart();
  }

  function toggleProduct(id) {
    const index = state.draft.findIndex((line) => line.product.id === id);
    if (index >= 0) {
      state.draft.splice(index, 1);
    } else {
      const product = state.list.find((p) => p.id === id);
      if (!product) return;
      if (needsSize(product)) {
        state.expanded = state.expanded === id ? null : id;
      } else {
        state.draft.push({ product, variantId: available(product)[0].id, self: false, editing: false });
        state.expanded = null;
      }
    }
    render();
    if (state.expanded === id) {
      const first = root.querySelector(`[data-owner="res-${id}"]:not(:disabled)`);
      if (first) first.focus({ preventScroll: true });
    }
  }

  function pickSize(owner, variantId) {
    if (owner.startsWith('res-')) {
      const id = Number(owner.slice(4));
      const product = state.list.find((p) => p.id === id);
      if (!product) return;
      state.draft.push({ product, variantId, self: false, editing: false });
      state.expanded = null;
      render();
      const button = root.querySelector(`[data-focus="add-${id}"]`);
      if (button) button.focus({ preventScroll: true });
    } else {
      const line = state.draft[Number(owner.slice(5))];
      if (!line) return;
      line.variantId = variantId;
      line.editing = false;
      render();
    }
    els.error.hidden = true;
  }

  async function addToCart() {
    const missing = state.draft.findIndex((line) => needsSize(line.product) && !line.variantId);
    if (missing >= 0) {
      const li = els.picked.querySelector(`[data-line="${missing}"]`);
      showError(`Choose a size for ${state.draft[missing].product.title}.`);
      if (li) {
        li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        li.classList.remove('is-flash');
        void li.offsetWidth;
        li.classList.add('is-flash');
        const chip = li.querySelector('.pdp-bb__size:not(:disabled)');
        if (chip) chip.focus({ preventScroll: true });
      }
      return;
    }
    if (!state.draft.length || state.busy) return;

    // Same size picked twice is one cart line with quantity 2.
    const quantities = new Map();
    state.draft.forEach((line) => quantities.set(line.variantId, (quantities.get(line.variantId) || 0) + 1));
    const items = Array.from(quantities, ([id, quantity]) => ({ id, quantity }));

    state.busy = true;
    els.error.hidden = true;
    renderFoot();
    try {
      const response = await fetch(`${CART_ADD_URL}.js`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ items, sections: 'mini-cart' })
      });
      const result = await response.json();
      if (!response.ok) {
        showError(result.description || result.message || 'These pieces could not be added. Please try again.');
        await refreshCart();
        state.busy = false;
        return render();
      }

      await refreshCart();
      const cart = Object.assign({}, state.cart, { sections: result.sections });
      document.documentElement.dispatchEvent(new CustomEvent('cart:updated', { bubbles: true, detail: { cart } }));
      document.documentElement.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true, detail: { cart, openMiniCart: true } }));

      state.draft = [];
      state.busy = false;
      close();
      // Focal opens the drawer from cart:refresh only when cart_type is
      // "drawer"; open it here too so the sheet never depends on that setting.
      const drawer = document.getElementById('mini-cart');
      if (drawer) drawer.open = true;
    } catch (error) {
      showError('These pieces could not be added. Please check your connection and try again.');
      state.busy = false;
      renderFoot();
    }
  }

  function showError(text) {
    els.error.textContent = text;
    els.error.hidden = false;
  }

  /* ---------- keyboard ---------- */

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      return close();
    }
    if (event.key !== 'Tab') return;
    if (!els.sheet.contains(document.activeElement)) {
      event.preventDefault();
      return els.title.focus();
    }
    const focusable = Array.from(els.sheet.querySelectorAll('button:not(:disabled), input, [tabindex]:not([tabindex="-1"])'))
      .filter((el) => el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === els.title)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /* ---------- wire the opener ---------- */

  document.addEventListener('click', (event) => {
    const opener = event.target.closest('[data-pdp-bundle-open]');
    if (!opener) return;
    event.preventDefault();
    open(opener);
  });

  window.CAU = window.CAU || {};
  window.CAU.bundleSheet = { open, close };
})();
