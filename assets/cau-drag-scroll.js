/* Grab-and-pull scrolling for the horizontal rails.

   Touch already scrolls these natively, and the arrows already step them.
   What is missing is the mouse: an overflow-x container gives a desktop
   pointer nothing to grab, so a rail with its scrollbar hidden looks stuck
   unless you find the arrows or own a trackpad.

   Touch pointers are left alone on purpose - native scrolling has momentum
   and rubber-banding that this cannot match. Scroll snapping is switched off
   for the duration of a drag, otherwise it fights the pointer, and switched
   back on release so the rail still settles on a card.

   Opt in with data-cau-drag-scroll on the scroll container. */

(() => {
  const DEAD_ZONE = 4; // px before a press counts as a drag rather than a click

  function enable(track) {
    if (track.dataset.cauDragReady) return;
    track.dataset.cauDragReady = 'true';

    let startX = 0;
    let startLeft = 0;
    let dragging = false;
    let moved = false;

    track.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'touch' || event.button !== 0) return;
      if (track.scrollWidth - track.clientWidth < 1) return;
      dragging = true;
      moved = false;
      startX = event.clientX;
      startLeft = track.scrollLeft;
    });

    track.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      if (!moved && Math.abs(dx) < DEAD_ZONE) return;

      if (!moved) {
        moved = true;
        track.classList.add('is-dragging');
        // Capture so the drag survives the pointer leaving the rail.
        try { track.setPointerCapture(event.pointerId); } catch (error) { /* not captureable */ }
      }
      track.scrollLeft = startLeft - dx;
      event.preventDefault();
    });

    const release = (event) => {
      if (!dragging) return;
      dragging = false;
      try { track.releasePointerCapture(event.pointerId); } catch (error) { /* never captured */ }
      if (!moved) return;
      track.classList.remove('is-dragging');
      // The browser fires a click on the card the drag ended over; swallow it.
      track.addEventListener('click', (click) => {
        click.preventDefault();
        click.stopPropagation();
      }, { capture: true, once: true });
    };

    track.addEventListener('pointerup', release);
    track.addEventListener('pointercancel', release);

    // Images and links are natively draggable, which hijacks the gesture.
    track.addEventListener('dragstart', (event) => {
      if (dragging) event.preventDefault();
    });
  }

  const init = () => document.querySelectorAll('[data-cau-drag-scroll]').forEach(enable);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  document.addEventListener('shopify:section:load', init);

  // Rails that are cloned in later - anything inside a <template> - are invisible
  // to the passes above, so they ask for a rescan once they are in the document.
  // enable() is idempotent, so rescanning costs nothing.
  window.CAU = window.CAU || {};
  window.CAU.dragScroll = { scan: init };
})();
