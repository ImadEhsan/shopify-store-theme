/* Reviews, from Loox's Storefront API.

   ES5 only - this is served raw, there is no build step.

   Two calls, deliberately split:

   - The bottomline (average, count, per-star distribution) is fetched at once,
     because the buy box's rating row sits above the fold and waiting for an
     IntersectionObserver that may never fire would leave it blank.
   - The review list waits until the section is within a screen of the
     viewport. On a product page this long most visitors never reach it, and
     the list is the expensive call of the two.

   The section renders two instances - the inline band and the popup opened
   from the rating row - each its own [data-pdp-reviews] root, and init() runs
   once per root. The popup root is the one with a [data-pdp-reviews-modal]
   inside it; its list is fetched on the first open rather than on scroll. The
   bottomline is the same answer for both, so it is requested once and the
   promise is shared (see bottomline() below).

   Review text is written with textContent throughout, never innerHTML. The
   bodies are customer-authored and arrive from a third party; the only places
   that take a URL from the response are an <img src>, a <video src> and an
   <a href>, each guarded by httpUrl() below.
*/
(function () {
  'use strict';

  var API = 'https://storefront-api.loox.io/storefront/v1/store/';

  window.CAU = window.CAU || {};

  /* One bottomline request per product, shared by every root on the page.
     Keyed by the full URL so a second store id (there is not one, but the
     markup allows it) would not be handed the first store's numbers. A failed
     request is dropped from the cache so the next root asks afresh. */
  var bottomlines = {};
  function bottomline(url) {
    if (!bottomlines[url]) {
      bottomlines[url] = fetch(url, { headers: { Accept: 'application/json' } })
        .then(function (r) {
          if (!r.ok) throw new Error('Loox API ' + r.status);
          return r.json();
        })
        .catch(function (err) {
          delete bottomlines[url];
          throw err;
        });
    }
    return bottomlines[url];
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* Loox serves its media over https, but the response is third-party input:
     anything that is not an http(s) URL never reaches an src or an href. */
  function httpUrl(raw) {
    if (!raw || typeof raw !== 'string') return '';
    var u;
    try { u = new URL(raw, window.location.href); } catch (e) { return ''; }
    return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : '';
  }

  /* Two dialogs can be open at once - a review photo on top of the reviews
     popup - and whichever closes first must not unlock the page under the one
     still open. Hence a count rather than a flag. */
  var locks = 0;
  function lockScroll(on) {
    var html = document.documentElement;
    var was = locks;
    locks = Math.max(0, locks + (on ? 1 : -1));
    if (locks > 0 === was > 0) return;

    if (locks > 0) {
      /* Locking the page takes its scrollbar away, which widens the viewport,
         and everything in the page slides sideways by its width exactly as
         the dialog animates in. scrollbar-gutter: stable (pdp-reviews.css)
         keeps the gutter so there is nothing to give back; measure anyway and
         pad by whatever the lock actually moved, for the browsers that do not
         have it. */
      var before = html.clientWidth;
      html.classList.add('pdp-reviews-locked');
      var shift = html.clientWidth - before;
      if (shift > 0) html.style.setProperty('--pdp-lock-gutter', shift + 'px');
    } else {
      html.classList.remove('pdp-reviews-locked');
      html.style.removeProperty('--pdp-lock-gutter');
    }
  }

  /* What the API hands back, turned into what the page can actually use.

     Two things the published example does not show but the live store does:

     - photos come back as type "photo", not "image";
     - video is Cloudflare Stream, and the url is the iframe PLAYER PAGE.
       Handing that to <video src> loads an HTML document and plays nothing.
       Stream serves a poster frame at a sibling path, so the same id gives
       both a thumbnail and an embeddable player.

     A url that is not Stream is assumed to be a real video file and keeps the
     plain <video> path. */
  function mediaItem(type, url) {
    var item = { url: url, video: type === 'video', embed: '', poster: '' };

    if (!item.video) {
      /* Loox keeps a resized copy beside the original. On this store _orig is
         1080x1440 and ~820KB; dropping the suffix gives 375x500 and ~31KB,
         ample for a 72px thumbnail even at 2x. The lightbox still opens
         item.url, which stays the full-size one. */
      item.poster = url.replace(/_orig(\.[a-z0-9]+)(\?.*)?$/i, '$1$2');
      return item;
    }

    var m = /^https:\/\/iframe\.videodelivery\.net\/([A-Za-z0-9]+)/.exec(url);
    if (m) {
      item.embed = url;
      item.poster = 'https://videodelivery.net/' + m[1] + '/thumbnails/thumbnail.jpg';
      return item;
    }

    m = /^https:\/\/(customer-[A-Za-z0-9]+\.cloudflarestream\.com)\/([A-Za-z0-9]+)\/iframe/.exec(url);
    if (m) {
      item.embed = url;
      item.poster = 'https://' + m[1] + '/' + m[2] + '/thumbnails/thumbnail.jpg';
    }
    return item;
  }

  function stars(pct) {
    var n = el('span', 'pdp-v2__stars');
    n.style.setProperty('--pct', pct + '%');
    n.setAttribute('aria-hidden', 'true');
    return n;
  }

  /* "15 January 2024". Intl is everywhere we support; the try/catch is for a
     malformed date string rather than a missing API. */
  function when(raw) {
    if (!raw) return '';
    var d = new Date(raw);
    if (isNaN(d.getTime())) return '';
    try {
      return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch (e) {
      return d.toISOString().slice(0, 10);
    }
  }

  function init(root) {
    var storeId = root.getAttribute('data-store');
    var productId = root.getAttribute('data-product');
    if (!storeId || !productId) return;

    var base = API + encodeURIComponent(storeId);

    var panel = root.querySelector('[data-pdp-reviews-panel]');
    var list = root.querySelector('[data-pdp-reviews-list]');
    var note = root.querySelector('[data-pdp-reviews-note]');
    var more = root.querySelector('[data-pdp-reviews-more]');
    var moreLabel = root.querySelector('[data-pdp-reviews-more-label]');
    var avgOut = root.querySelector('[data-pdp-reviews-avg]');
    var basisOut = root.querySelector('[data-pdp-reviews-basis]');
    var bigStars = root.querySelector('.pdp-reviews__bigstars');
    var dist = root.querySelector('[data-pdp-reviews-dist]');
    var sortSel = root.querySelector('[data-pdp-reviews-sort]');
    var clearBtn = root.querySelector('[data-pdp-reviews-clear]');
    var clearLabel = root.querySelector('[data-pdp-reviews-clear-label]');
    /* Present only when the section is set to show as a popup. Everything
       below reads it as "is there a dialog wrapped around all this". */
    var modal = root.querySelector('[data-pdp-reviews-modal]');
    if (!list) return;

    var perPage = parseInt(root.getAttribute('data-per-page'), 10) || 6;
    var isSlider = root.getAttribute('data-layout') === 'slider';

    var arrows = root.querySelector('[data-pdp-reviews-arrows]');
    var prevBtn = root.querySelector('[data-pdp-reviews-prev]');
    var nextBtn = root.querySelector('[data-pdp-reviews-next]');
    var progress = root.querySelector('[data-pdp-reviews-progress]');
    var thumb = root.querySelector('[data-pdp-reviews-thumb]');

    var state = {
      page: 0,            /* pages already rendered */
      total: null,        /* fed back to the API to skip its own count */
      star: '',           /* '' = every rating */
      sort: root.getAttribute('data-sort') || 'featured',
      direction: 'desc',
      loading: false,
      hasMore: false,
      media: []           /* every photo on screen, in render order, for the lightbox */
    };

    if (sortSel) sortSel.value = state.sort;

    function say(msg) {
      if (!note) return;
      note.textContent = msg || '';
      note.hidden = !msg;
    }

    function get(path) {
      return fetch(base + path, { headers: { Accept: 'application/json' } })
        .then(function (r) {
          if (!r.ok) throw new Error('Loox API ' + r.status);
          return r.json();
        });
    }

    /* ---- bottomline: average, count, distribution ---------------------- */

    function paintBottomline(b) {
      var avg = parseFloat(b.averageRating);
      var count = parseInt(b.totalReviews, 10);
      if (!avg || !count) {
        /* No reviews is a legitimate answer, not a failure. Hide section on storefront so no empty gap shows. */
        var sec = root.closest('.pdp-reviews');
        if (sec && !modal && !(window.Shopify && window.Shopify.designMode)) {
          sec.hidden = true;
        }
        return false;
      }

      /* The buy box and the section heading both read this. */
      if (typeof window.CAU.setRating === 'function') window.CAU.setRating(avg, count);

      if (avgOut) avgOut.textContent = avg.toFixed(1);
      if (bigStars) bigStars.style.setProperty('--pct', (avg * 20) + '%');
      if (basisOut) {
        basisOut.textContent = 'Based on ' + count +
          (count === 1 ? ' verified review' : ' verified reviews');
      }

      if (dist) {
        var buckets = b.ratingDistribution || {};
        var rows = dist.querySelectorAll('[data-pdp-reviews-star]');
        for (var i = 0; i < rows.length; i++) {
          var btn = rows[i];
          var n = parseInt(buckets[btn.getAttribute('data-pdp-reviews-star')], 10) || 0;
          var bar = btn.querySelector('.pdp-reviews__bar > span');
          var num = btn.querySelector('.pdp-reviews__distnum');
          /* Share of the total, so the five bars read against each other. */
          if (bar) bar.style.setProperty('--w', (n / count * 100).toFixed(1) + '%');
          if (num) num.textContent = n;
          /* A star nobody gave is not a filter worth offering. */
          btn.disabled = n === 0;
        }
      }

      var sec = root.closest('.pdp-reviews');
      if (sec) sec.hidden = false;
      if (panel) panel.hidden = false;
      return true;
    }

    /* ---- the list ------------------------------------------------------ */

    function card(rev) {
      var c = el('article', 'pdp-reviews__card');

      var head = el('div', 'pdp-reviews__whead');
      var who = el('div', 'pdp-reviews__who');
      who.appendChild(el('span', 'pdp-reviews__name',
        (rev.reviewer && rev.reviewer.name) ? rev.reviewer.name : 'Anonymous'));

      if (rev.verified) {
        var vb = el('span', 'pdp-reviews__badge');
        vb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
          'stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M20 6 9 17l-5-5"/></svg>';
        vb.appendChild(document.createTextNode('Verified'));
        who.appendChild(vb);
      }
      head.appendChild(who);

      var rating = parseFloat(rev.rating) || 0;
      var sr = stars(rating * 20);
      /* The visual stars are aria-hidden, so the rating still has to be said. */
      var srWrap = el('span', 'pdp-reviews__cardrating');
      srWrap.appendChild(sr);
      srWrap.appendChild(el('span', 'pdp-reviews__sr', rating + ' out of 5'));
      head.appendChild(srWrap);
      c.appendChild(head);

      var date = when(rev.date || rev.createdAt);
      if (date) c.appendChild(el('div', 'pdp-reviews__date', date));

      if (rev.body) c.appendChild(el('p', 'pdp-reviews__body', rev.body));

      /* Loox's AI highlights, when the plan returns them: short phrases lifted
         from the review. Shown under the body as quiet chips. */
      if (rev.highlights && rev.highlights.length) {
        var hl = el('ul', 'pdp-reviews__highlights');
        for (var h = 0; h < rev.highlights.length && h < 3; h++) {
          hl.appendChild(el('li', null, rev.highlights[h]));
        }
        c.appendChild(hl);
      }

      var media = rev.media || [];
      if (media.length) {
        var strip = el('div', 'pdp-reviews__media');
        for (var m = 0; m < media.length; m++) {
          var url = httpUrl(media[m] && media[m].url);
          if (!url) continue;

          var item = mediaItem(media[m].type, url);
          var idx = state.media.length;
          state.media.push(item);

          var thumb = el('button', 'pdp-reviews__thumb');
          thumb.type = 'button';
          thumb.setAttribute('data-pdp-reviews-open', idx);
          thumb.setAttribute('aria-label', item.video ? 'Play review video' : 'View review photo');

          if (item.poster) {
            var img = document.createElement('img');
            img.src = item.poster;
            img.alt = '';
            img.loading = 'lazy';
            img.decoding = 'async';
            img.width = 160;
            img.height = 160;
            thumb.appendChild(img);
          } else {
            /* A direct video file with no poster to borrow. preload=metadata
               is enough for the browser to paint a first frame. */
            var v = document.createElement('video');
            v.src = item.url;
            v.muted = true;
            v.playsInline = true;
            v.preload = 'metadata';
            thumb.appendChild(v);
          }
          if (item.video) thumb.appendChild(el('span', 'pdp-reviews__play'));

          strip.appendChild(thumb);
        }
        if (strip.childNodes.length) c.appendChild(strip);
      }

      if (rev.reply && rev.reply.body) {
        var reply = el('div', 'pdp-reviews__reply');
        reply.appendChild(el('span', 'pdp-reviews__replywho', 'Copped AU'));
        reply.appendChild(el('p', null, rev.reply.body));
        c.appendChild(reply);
      }

      return c;
    }

    /* ---- placeholders --------------------------------------------------- */

    /* Shaped like a real card - head row, date, three lines of body - so the
       space it holds is roughly the space the answer takes. aria-hidden, with
       the list marked busy instead: a screen reader should hear "loading",
       not read out six empty cards. */
    function skeleton() {
      var c = el('article', 'pdp-reviews__card pdp-reviews__card--skel');
      c.setAttribute('aria-hidden', 'true');

      var head = el('div', 'pdp-reviews__whead');
      head.appendChild(el('span', 'pdp-reviews__skel pdp-reviews__skel--name'));
      head.appendChild(el('span', 'pdp-reviews__skel pdp-reviews__skel--stars'));
      c.appendChild(head);

      c.appendChild(el('span', 'pdp-reviews__skel pdp-reviews__skel--date'));

      var body = el('div', 'pdp-reviews__skellines');
      for (var i = 0; i < 3; i++) body.appendChild(el('span', 'pdp-reviews__skel'));
      c.appendChild(body);

      return c;
    }

    function showSkeletons() {
      list.setAttribute('aria-busy', 'true');
      var frag = document.createDocumentFragment();
      for (var i = 0; i < perPage; i++) frag.appendChild(skeleton());
      list.appendChild(frag);
      if (isSlider) syncRail();
    }

    /* Called at the top of both outcomes, so real cards never land beside a
       placeholder. Also releases the height hold reset() put on the list. */
    function clearSkeletons() {
      var sk = list.querySelectorAll('.pdp-reviews__card--skel');
      for (var i = 0; i < sk.length; i++) list.removeChild(sk[i]);
      list.removeAttribute('aria-busy');
      list.style.minHeight = '';
    }

    function query(page) {
      var q = '?product_id=' + encodeURIComponent(productId) +
              '&page=' + page +
              '&limit=' + perPage +
              '&sort=' + encodeURIComponent(state.sort) +
              '&direction=' + encodeURIComponent(state.direction);
      if (state.star) q += '&rating=' + encodeURIComponent(state.star);
      /* Handing back the total we were given skips a countDocuments on their
         side. It is per-filter, so it is cleared whenever the filter changes. */
      if (state.total != null) q += '&total=' + state.total;
      return q;
    }

    function load() {
      if (state.loading) return;
      state.loading = true;
      if (more) more.disabled = true;
      if (moreLabel && state.page > 0) moreLabel.textContent = 'Loading…';

      /* Before the request, not after it: the point is to hold the space the
         answer will occupy, so the page does not jump when it arrives. */
      showSkeletons();

      var page = state.page + 1;

      get('/product-reviews' + query(page)).then(function (data) {
        clearSkeletons();
        var reviews = (data && data.reviews) || [];
        var pg = (data && data.pagination) || {};

        if (pg.total != null) state.total = pg.total;

        if (!reviews.length && page === 1) {
          list.innerHTML = '';
          state.media = [];
          say(state.star
            ? 'No ' + state.star + '-star reviews yet.'
            : 'No reviews yet.');
          state.hasMore = false;
          if (more) more.hidden = true;
          syncRail();
          return;
        }

        say('');
        var frag = document.createDocumentFragment();
        for (var i = 0; i < reviews.length; i++) frag.appendChild(card(reviews[i]));
        list.appendChild(frag);

        state.page = page;
        state.hasMore = !!pg.hasMore;
        /* In slider mode the rail pulls the next page itself, so the button
           would only ever duplicate a gesture the visitor already has. */
        if (more) more.hidden = isSlider || !pg.hasMore;
        if (isSlider) syncRail();
      }).catch(function (err) {
        /* A failed call must not leave the page looking broken. If we have no
           reviews on screen at all, close the panel and let Loox's own section
           (if it is still in the template) be the reviews. */
        clearSkeletons();
        if (window.console && console.warn) console.warn('[pdp-reviews]', err);
        if (state.page === 0 && modal) {
          /* The dialog is already open and looked at. Emptying it out would
             leave a blank box with no explanation; the note says what
             happened and the button is the retry. */
          say('Could not load reviews. Please try again.');
          state.hasMore = false;
          if (more) more.hidden = false;
        } else if (state.page === 0) {
          if (panel) panel.hidden = true;
          var sec = root.closest('.pdp-reviews');
          if (sec && !modal && !(window.Shopify && window.Shopify.designMode)) {
            sec.hidden = true;
          }
        } else {
          /* Stop the rail asking again. Left alone, every scroll event past
             the threshold would re-fire a call that is already failing. The
             button comes back as the manual retry instead - in slider mode
             too, where it is otherwise hidden. */
          state.hasMore = false;
          say('Could not load more reviews. Please try again.');
          if (more) more.hidden = false;
          syncRail();
        }
      }).then(function () {
        state.loading = false;
        if (more) more.disabled = false;
        if (moreLabel) moreLabel.textContent = 'Load more reviews';
      });
    }

    /* ---- the rail ------------------------------------------------------ */

    /* One card plus the gap. grid-auto-columns is not resolved to pixels by
       getComputedStyle - it comes back as the computed calc(), which parseFloat
       reads as NaN - so the rendered card is the honest source. columnGap IS
       resolved. Same lesson as the UGC carousel. */
    function step() {
      var first = list.firstElementChild;
      var gap = parseFloat(getComputedStyle(list).columnGap) || 16;
      return (first ? first.getBoundingClientRect().width : list.clientWidth) + gap;
    }

    function scrollable() {
      /* scrollWidth can exceed clientWidth by a sub-pixel on fractional
         layouts, hence the tolerance. */
      return list.scrollWidth - list.clientWidth > 4;
    }

    function syncRail() {
      if (!isSlider) return;
      var on = scrollable();
      if (arrows) arrows.hidden = !on;
      if (progress) progress.hidden = !on;
      if (!on) return;

      var max = list.scrollWidth - list.clientWidth;
      var ratio = list.clientWidth / list.scrollWidth;

      if (prevBtn) prevBtn.disabled = list.scrollLeft <= 1;
      /* Only a dead end once the last page is in: short of that the next
         press loads more. */
      if (nextBtn) nextBtn.disabled = !state.hasMore && list.scrollLeft >= max - 1;

      if (!thumb) return;
      /* translateX(%) is relative to the thumb's OWN width, so the travel is
         (100 - w) / w. The 8% floor makes deriving it from `ratio` wrong once
         the floor bites, so derive it from the width actually assigned. */
      var w = Math.max(ratio * 100, 8);
      thumb.style.width = w + '%';
      thumb.style.transform =
        'translateX(' + (max > 0 ? (list.scrollLeft / max) * ((100 - w) / w * 100) : 0) + '%)';
    }

    if (isSlider) {
      if (prevBtn) prevBtn.addEventListener('click', function () {
        list.scrollBy({ left: -step(), behavior: 'smooth' });
      });
      if (nextBtn) nextBtn.addEventListener('click', function () {
        list.scrollBy({ left: step(), behavior: 'smooth' });
      });

      list.addEventListener('scroll', function () {
        syncRail();
        /* Pull the next page while there is still a screen of rail left to
           scroll, so the cards are in place before the visitor reaches them. */
        if (state.hasMore && !state.loading &&
            list.scrollWidth - list.clientWidth - list.scrollLeft < list.clientWidth) {
          load();
        }
      }, { passive: true });

      window.addEventListener('resize', syncRail);
    }

    function reset() {
      /* Hold the height the list already has. The placeholders cover most of
         the swap, but releasing the hold only once real cards land means the
         page settles once rather than collapsing and springing back. */
      var held = list.getBoundingClientRect().height;
      if (held) list.style.minHeight = held + 'px';

      state.page = 0;
      state.total = null;
      state.media = [];
      state.hasMore = false;
      list.innerHTML = '';
      if (more) more.hidden = true;
      /* The new set starts at its first card, not wherever the old one was
         scrolled to. Jump, not glide: this is a different list. */
      if (isSlider) list.scrollLeft = 0;
      syncRail();
      say('');
      load();
    }

    /* ---- filter and sort ----------------------------------------------- */

    function setStar(star) {
      state.star = star || '';

      if (dist) {
        var rows = dist.querySelectorAll('[data-pdp-reviews-star]');
        for (var i = 0; i < rows.length; i++) {
          var on = rows[i].getAttribute('data-pdp-reviews-star') === state.star;
          rows[i].setAttribute('aria-pressed', on ? 'true' : 'false');
          rows[i].classList.toggle('is-on', on);
        }
      }
      if (clearBtn) {
        clearBtn.hidden = !state.star;
        if (clearLabel && state.star) {
          clearLabel.textContent = state.star + '-star reviews only';
        }
      }
      reset();
    }

    if (dist) {
      dist.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-pdp-reviews-star]');
        if (!btn || btn.disabled) return;
        var star = btn.getAttribute('data-pdp-reviews-star');
        /* Clicking the active row is the way back to every rating. */
        setStar(star === state.star ? '' : star);
      });
    }

    if (clearBtn) clearBtn.addEventListener('click', function () { setStar(''); });

    if (sortSel) {
      sortSel.addEventListener('change', function () {
        /* "Lowest rated" is the rating sort read the other way, so the select
           carries direction in the same value rather than adding a control. */
        var parts = sortSel.value.split(':');
        state.sort = parts[0];
        state.direction = parts[1] || 'desc';
        reset();
      });
    }

    if (more) more.addEventListener('click', load);

    /* ---- lightbox ------------------------------------------------------ */

    var box = root.querySelector('[data-pdp-reviews-box]');
    if (box) {
      var boxImg = box.querySelector('[data-pdp-reviews-box-img]');
      var boxVid = box.querySelector('[data-pdp-reviews-box-vid]');
      var boxEmbed = box.querySelector('[data-pdp-reviews-box-embed]');
      var boxCount = box.querySelector('[data-pdp-reviews-box-count]');
      var boxSkel = box.querySelector('[data-pdp-reviews-box-skel]');
      var at = 0;
      var opener = null;
      /* Which request owns the stage. A photo that lands after the visitor has
         pressed on again must not paint over the one they are looking at. */
      var turn = 0;

      function skel(on) {
        if (boxSkel) boxSkel.hidden = !on;
      }

      /* The neighbours, fetched quietly once the current photo is up, so an
         arrow press swaps in an already-decoded image on the spot instead of
         emptying the stage and filling it again. */
      function prefetch(i) {
        var items = state.media;
        if (!items.length) return;
        /* Not on a metered or slow connection: these are the full-size files,
           ~800KB each, and someone on 3G wants the one they asked for and
           nothing else. */
        var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (c && (c.saveData || /2g/.test(c.effectiveType || ''))) return;
        var it = items[(i + items.length) % items.length];
        if (!it || it.video || !it.url) return;
        var p = new Image();
        p.src = it.url;
      }

      function show(i) {
        var items = state.media;
        if (!items.length) return;
        /* Wraps, so the arrows never dead-end. */
        at = (i + items.length) % items.length;
        var item = items[at];
        var mine = ++turn;

        /* Reset all three first, so nothing from the previous item lingers -
           an iframe especially, which would otherwise keep playing. */
        boxVid.pause();
        boxVid.hidden = true;
        boxVid.removeAttribute('src');
        boxImg.hidden = true;
        boxImg.removeAttribute('src');
        if (boxEmbed) { boxEmbed.hidden = true; boxEmbed.removeAttribute('src'); }
        skel(false);

        if (boxCount) boxCount.textContent = (at + 1) + ' / ' + items.length;

        if (item.embed && boxEmbed) {
          boxEmbed.src = item.embed;
          boxEmbed.hidden = false;
        } else if (item.video) {
          boxVid.src = item.url;
          boxVid.hidden = false;
        } else {
          /* Full size here, not the thumbnail the card used - and decoded
             before it is put on the stage, so the photo appears whole rather
             than painting in as it arrives. One already in cache - the
             neighbour prefetched below, or the one just stepped away from - is
             complete the moment its src is set, so it goes up in this same
             frame and the skeleton never flashes. */
          var pre = new Image();
          var done = function () {
            if (mine !== turn) return;
            boxImg.src = item.url;
            boxImg.hidden = false;
            skel(false);
          };
          pre.onload = done;
          /* A photo that will not load must not leave the stage shimmering for
             ever; an empty frame is the honest end of it. */
          pre.onerror = function () { if (mine === turn) skel(false); };
          pre.src = item.url;
          if (pre.complete) done();
          else skel(true);
        }

        prefetch(at + 1);
        prefetch(at - 1);
      }

      function open(i, from) {
        opener = from || null;
        /* Lock, then reveal - as the reviews popup does, and for the same
           reason: the lock's measurements force a layout. */
        lockScroll(true);
        box.hidden = false;
        show(i);
        var close = box.querySelector('[data-pdp-reviews-box-close]');
        if (close) close.focus();
      }

      function close() {
        box.hidden = true;
        lockScroll(false);
        /* Nothing still in flight owns the stage any more. */
        turn++;
        skel(false);
        boxVid.pause();
        boxVid.removeAttribute('src');
        /* Dropping the src is what actually stops a Stream embed playing. */
        if (boxEmbed) { boxEmbed.hidden = true; boxEmbed.removeAttribute('src'); }
        /* Send focus back where it came from, or it lands at the top of the
           document and a keyboard visitor loses their place in the list. */
        if (opener) { opener.focus(); opener = null; }
      }

      list.addEventListener('click', function (e) {
        var t = e.target.closest('[data-pdp-reviews-open]');
        if (!t) return;
        open(parseInt(t.getAttribute('data-pdp-reviews-open'), 10) || 0, t);
      });

      box.addEventListener('click', function (e) {
        if (e.target.closest('[data-pdp-reviews-box-close]')) return close();
        if (e.target.closest('[data-pdp-reviews-box-prev]')) return show(at - 1);
        if (e.target.closest('[data-pdp-reviews-box-next]')) return show(at + 1);
        /* The scrim is the element itself; a click inside the panel is not a
           click on it. */
        if (e.target === box) close();
      });

      document.addEventListener('keydown', function (e) {
        if (box.hidden) return;
        if (e.key === 'Escape') close();
        else if (e.key === 'ArrowLeft') show(at - 1);
        else if (e.key === 'ArrowRight') show(at + 1);
      });
    }

    /* ---- the popup ------------------------------------------------------ */

    if (modal) {
      var modalPanel = modal.querySelector('.revmodal__panel');
      var fetched = false;   /* the list is pulled on the first open, once */
      var cameFrom = null;

      /* The trigger is the rating row in the buy box - a different section.
         It ships as a plain anchor to #reviews so it still does something
         before this script runs. Here it becomes the button that opens the
         dialog; the inline band under #reviews stays where it is and loads
         on its own when scrolled to. */
      function triggers() {
        return document.querySelectorAll('[data-pdp-rating-open]');
      }

      /* The chevron and the hover tint hang off a class on <html>, not off the
         row: Focal re-renders the buy box on a variant change, and a class put
         on the row itself would go with the old markup. The aria pair has to
         be re-applied after such a re-render, hence the section:load hook. */
      document.documentElement.classList.add('pdp-reviews-has-modal');

      function markTriggers(open) {
        var t = triggers();
        for (var i = 0; i < t.length; i++) {
          t[i].setAttribute('aria-haspopup', 'dialog');
          t[i].setAttribute('aria-expanded', open ? 'true' : 'false');
        }
      }
      markTriggers(false);
      document.addEventListener('shopify:section:load', function () {
        if (document.contains(modal)) markTriggers(!modal.hidden);
      });

      /* Tab stops, in document order. Anything hidden - the clear chip, the
         Load more button, a star nobody gave - has no box, and a focus trap
         that cycled through those would feel broken. */
      function focusables() {
        var all = modalPanel.querySelectorAll(
          'a[href], button:not(:disabled), select:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'
        );
        var out = [];
        for (var i = 0; i < all.length; i++) {
          if (all[i].getClientRects().length) out.push(all[i]);
        }
        return out;
      }

      function openModal(from) {
        if (!modal.hidden) return;
        /* The theme editor re-renders the section on every setting change,
           which leaves this closure holding the previous, detached dialog.
           Opening that one would lock the page behind a dialog nobody can
           see; the live section's own listener is the one that should run. */
        if (!document.contains(modal)) return;
        cameFrom = from || document.activeElement;
        /* Locked first, shown second. The lock measures the page twice, and
           both measurements force a layout: cheaper with the dialog - and its
           backdrop blur - still out of the tree. */
        lockScroll(true);
        modal.hidden = false;
        markTriggers(true);

        if (!fetched) {
          fetched = true;
          /* Synchronous: the placeholder cards go in before the panel is
             painted, so the dialog opens with its contents already the size
             they will stay. */
          load();
        }
        /* The rail cannot be measured while the dialog is display:none: every
           width comes back 0, so syncRail would decide it does not overflow
           and leave the arrows and the progress bar hidden. Measured here,
           with it on screen. */
        syncRail();

        var close = modal.querySelector('[data-pdp-reviews-modal-close]');
        if (close) close.focus();
      }

      function closeModal() {
        if (modal.hidden) return;
        modal.hidden = true;
        lockScroll(false);
        markTriggers(false);
        /* Back to the rating row, not the top of the document. */
        if (cameFrom && document.contains(cameFrom)) cameFrom.focus();
        cameFrom = null;
      }

      /* Delegated: the buy box re-renders on a variant change, and a listener
         bound to the row itself would go with it. */
      document.addEventListener('click', function (e) {
        var t = e.target.closest('[data-pdp-rating-open]');
        if (!t) return;
        e.preventDefault();
        openModal(t);
      });

      modal.addEventListener('click', function (e) {
        if (e.target.closest('[data-pdp-reviews-modal-close]')) return closeModal();
        /* The scrim is the element itself; a click inside the panel is not a
           click on it. */
        if (e.target === modal) closeModal();
      });

      document.addEventListener('keydown', function (e) {
        if (modal.hidden) return;
        /* A review photo opens on top of this dialog and takes Escape and the
           arrow keys for itself while it is up. */
        if (box && !box.hidden) return;

        if (e.key === 'Escape') return closeModal();
        if (e.key !== 'Tab') return;

        var f = focusables();
        if (!f.length) return;
        var first = f[0];
        var last = f[f.length - 1];
        /* Focus must not walk out of the dialog and into the page behind it. */
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      });

      /* The rail's measurements are only valid while the dialog is up, so the
         section's own resize listener (slider mode) is not enough on its own:
         in grid mode there is none at all. */
      window.addEventListener('resize', function () {
        if (!modal.hidden) syncRail();
      });
    }

    /* ---- kick off ------------------------------------------------------ */

    bottomline(base + '/product-reviews/bottomline/' + encodeURIComponent(productId))
      .then(function (b) {
        if (!paintBottomline(b || {})) return;

        /* The popup's list waits to be asked for: there is nothing in the
           page to scroll towards, and most visitors never open it. */
        if (modal) return;

        /* The list is the expensive call, so it waits for the section to come
           within a screen of the viewport. No IntersectionObserver (or a
           section already on screen) means fetch it now. */
        if (!('IntersectionObserver' in window)) return load();

        var io = new IntersectionObserver(function (entries) {
          if (!entries[0].isIntersecting) return;
          io.disconnect();
          load();
        }, { rootMargin: '100% 0px' });
        io.observe(root);
      })
      .catch(function (err) {
        if (window.console && console.warn) console.warn('[pdp-reviews]', err);
        /* Leaving CAU.ratingSet unlatched lets pdp.js's scraper fall back to
           Loox's own widget for the rating row. */
      });
  }

  function boot() {
    var roots = document.querySelectorAll('[data-pdp-reviews]');
    for (var i = 0; i < roots.length; i++) {
      if (roots[i].getAttribute('data-pdp-reviews-ready')) continue;
      roots[i].setAttribute('data-pdp-reviews-ready', '1');
      init(roots[i]);
    }
  }

  boot();
  /* The theme editor re-renders the section on every setting change. */
  document.addEventListener('shopify:section:load', boot);
})();
