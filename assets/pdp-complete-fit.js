/* Complete the fit.

   Fetches the cards, then wires them. The add itself is Focal's
   <form is="product-form">; this file only:
   - opens and closes a card's size chips,
   - submits the card's form when a chip is picked,
   - opens the cart drawer after a successful add, in place of Focal's
     "added to cart" message (cart_type is "message" store-wide; only these
     cards open the drawer). Errors still reach Focal's message. */

(() => {
  if (customElements.get('pdp-complete-fit')) return;

  class PdpCompleteFit extends HTMLElement {
    async connectedCallback() {
      this.gridSlot = this.querySelector('[data-pdp-fit-slot]');
      if (!this.gridSlot) return;

      // Complementary is the merchant's own list; related is the fallback.
      for (const intent of ['complementary', 'related']) {
        const grid = await this.fetchGrid(intent);
        if (grid) {
          this.gridSlot.innerHTML = grid.innerHTML;
          this.hidden = false;
          this.wire();
          return;
        }
      }
    }

    async fetchGrid(intent) {
      const base = window.themeVariables?.routes?.productRecommendationsUrl
        || `${window.Shopify?.routes?.root || '/'}recommendations/products`;
      const params = new URLSearchParams({
        section_id: this.getAttribute('section-id'),
        product_id: this.getAttribute('product-id'),
        limit: this.getAttribute('limit') || '8',
        intent
      });
      try {
        const response = await fetch(`${base}?${params}`);
        if (!response.ok) return null;
        const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        const grid = doc.querySelector('[data-pdp-fit-grid]');
        return grid && grid.querySelector('.pdp-fit__card') ? grid : null;
      } catch (error) {
        return null;
      }
    }

    /* Slider controls, the same as Worn by the community: arrows step one
       card, the bar tracks the scroll, both hidden when nothing scrolls. */
    slider() {
      const track = this.gridSlot;
      const arrows = this.querySelector('[data-pdp-fit-arrows]');
      const progress = this.querySelector('[data-pdp-fit-progress]');
      const thumb = this.querySelector('[data-pdp-fit-thumb]');

      const sync = () => {
        const max = track.scrollWidth - track.clientWidth;
        const on = max > 4;
        arrows.hidden = !on;
        progress.hidden = !on;
        if (!on) return;
        // translateX(%) is relative to the thumb's own width, so travel is (100 - w) / w.
        const w = Math.max((track.clientWidth / track.scrollWidth) * 100, 8);
        thumb.style.width = `${w}%`;
        thumb.style.transform = `translateX(${(track.scrollLeft / max) * ((100 - w) / w) * 100}%)`;
      };
      const step = () => {
        const card = track.firstElementChild;
        const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
        return (card ? card.getBoundingClientRect().width : track.clientWidth / 4) + gap;
      };

      this.querySelector('[data-pdp-fit-prev]').addEventListener('click', () => track.scrollBy({ left: -step(), behavior: 'smooth' }));
      this.querySelector('[data-pdp-fit-next]').addEventListener('click', () => track.scrollBy({ left: step(), behavior: 'smooth' }));
      track.addEventListener('scroll', sync, { passive: true });
      window.addEventListener('resize', sync);
      sync();
    }

    wire() {
      this.slider();

      this.addEventListener('click', (event) => {
        const toggle = event.target.closest('[data-pdp-fit-toggle]');
        if (toggle) this.setOpen(toggle, toggle.getAttribute('aria-expanded') !== 'true');
      });

      // The chips float over the page, so a click anywhere else closes them.
      document.addEventListener('click', (event) => {
        this.querySelectorAll('[data-pdp-fit-toggle][aria-expanded="true"]').forEach((toggle) => {
          if (!toggle.form.contains(event.target)) this.setOpen(toggle, false);
        });
      });

      this.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        const sizes = event.target.closest('.pdp-fit__sizes');
        if (!sizes) return;
        const toggle = this.querySelector(`[aria-controls="${sizes.id}"]`);
        this.setOpen(toggle, false);
        toggle.focus();
      });

      this.addEventListener('change', (event) => {
        const radio = event.target;
        if (radio.name !== 'id' || radio.type !== 'radio') return;
        radio.form.requestSubmit();
      });

      this.querySelectorAll('[data-pdp-fit-form]').forEach((form) => {
        // Success goes to the drawer instead; errors still bubble to Focal.
        form.addEventListener('cart-notification:show', (event) => {
          if (event.detail?.status === 'success') event.stopPropagation();
        });

        form.addEventListener('variant:added', () => {
          const toggle = form.querySelector('[data-pdp-fit-toggle]');
          if (toggle) this.setOpen(toggle, false);
          form.querySelectorAll('input[type="radio"]').forEach((radio) => { radio.checked = false; });

          // Focal fires cart:refresh once the cart is re-fetched; the drawer
          // re-renders on it, so open the drawer then rather than before.
          document.documentElement.addEventListener('cart:refresh', () => {
            const drawer = document.getElementById('mini-cart');
            if (drawer) drawer.open = true;
          }, { once: true });
        });
      });
    }

    setOpen(toggle, open) {
      const sizes = document.getElementById(toggle.getAttribute('aria-controls'));
      if (!sizes) return;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      sizes.hidden = !open;
      if (open) sizes.querySelector('input:not(:disabled)')?.focus({ preventScroll: true });
    }
  }

  customElements.define('pdp-complete-fit', PdpCompleteFit);
})();
