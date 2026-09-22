/* FileHub — GSAP interactions.
   Patterns follow GSAP official guides:
   - FOUC: hide in CSS, reveal with autoAlpha, <noscript> fallback
   - SplitText after document.fonts.ready, autoSplit + onSplit
   - gsap.matchMedia() for prefers-reduced-motion + user motion toggle
   - ScrollTrigger.batch for grids, once:true reveals, scrub for progress
   - ScrollSmoother with fixed elements outside #smooth-wrapper
   - Flip for list reordering, quickTo for magnetic buttons
*/
window.addEventListener("error", (e) => {
  (window.__fhErrors = window.__fhErrors || []).push(String(e.message));
});
gsap.registerPlugin(ScrollTrigger, ScrollToPlugin, ScrollSmoother, SplitText, Flip, ScrambleTextPlugin);

const HEADER_OFFSET = 80;
const motionPref = () => localStorage.getItem("fh-set-motion") !== "off";
const mm = gsap.matchMedia();

/* ---------------------------------------------------------------- helpers */

/* ---------------------------------------------------------------- ambient work

   Decorative loops (marquees, drifting glows) are wasteful when nobody is
   looking at them: the browser keeps compositing frames, which shows up as
   dropped frames while dragging another window over the page. Anything
   registered here is paused when the tab is hidden and when it scrolls out
   of view.
*/
const ambientTweens = new Set();
let ambientPaused = false;

function registerAmbient(tween) {
  if (tween) ambientTweens.add(tween);
  return tween;
}

function syncAmbient() {
  const hidden = document.hidden || document.visibilityState !== "visible";
  if (hidden === ambientPaused) return;
  ambientPaused = hidden;
  ambientTweens.forEach((t) => (hidden ? t.pause() : t.resume()));
}

document.addEventListener("visibilitychange", syncAmbient);
window.addEventListener("blur", syncAmbient);
window.addEventListener("focus", syncAmbient);
syncAmbient();



function toast(msg) {
  const box = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  box.appendChild(el);
  gsap.fromTo(el, { autoAlpha: 0, x: 40 }, { autoAlpha: 1, x: 0, duration: 0.4, ease: "power3.out" });
  gsap.to(el, { autoAlpha: 0, x: 40, delay: 3.2, duration: 0.35, ease: "power2.in", onComplete: () => el.remove() });
}

function scrollToTarget(sel) {
  const target = document.querySelector(sel);
  if (!target) return;
  const smoother = ScrollSmoother.get();
  if (smoother) smoother.scrollTo(target, true, `top ${HEADER_OFFSET}px`);
  else gsap.to(window, { scrollTo: { y: target, offsetY: HEADER_OFFSET }, duration: 0.8, ease: "power3.inOut" });
}

/* Magnetic buttons.
   The pull used to start only once the pointer was inside the button, which
   made the effect feel like a hover state rather than a magnetic field. It now
   arms a little outside the button's own box so the button begins leaning
   toward the cursor just before it arrives.
   REACH is measured from the button's EDGE, not its centre. Measuring from the
   centre makes the feel depend on the button's size — a wide CTA would throw a
   field tens of pixels past its own border and visibly yank at the pointer from
   well outside it. From the edge, every button has the same margin.
   One document-level listener drives every button: an O(buttons) scan per move
   is cheaper than the per-element listeners it replaces, and it lets a button
   release the moment the pointer leaves its field. */
const MAGNET_REACH = 10;      // px beyond the button's edge
const MAGNET_PULL = 0.22;     // how far the button follows the cursor, x
const MAGNET_PULL_Y = 0.30;

function initMagnetic() {
  const buttons = [...document.querySelectorAll(".magnetic")]
    .filter((b) => !b.dataset.magnetic)
    .map((btn) => {
      btn.dataset.magnetic = "on";
      // Two ways to size the field, chosen per button:
      //   data-magnet-centre → a circle of data-magnet-reach px around the
      //     element's centre (used where the request was explicitly radial)
      //   default → data-magnet-reach px past each edge, which keeps the field
      //     hugging the button whatever its aspect ratio
      const reach = parseFloat(btn.dataset.magnetReach);
      return {
        btn,
        reach: Number.isFinite(reach) ? reach : MAGNET_REACH,
        radial: btn.dataset.magnetCentre === "1",
        box: null,                       // cached rect, refreshed on scroll/resize
        x: gsap.quickTo(btn, "x", { duration: 0.4, ease: "power3.out" }),
        y: gsap.quickTo(btn, "y", { duration: 0.4, ease: "power3.out" }),
      };
    });
  if (!buttons.length || document.__magnetBound) return;
  document.__magnetBound = true;

  // The rect is needed for every pointer move, but reading it forces layout.
  // Cache it and refresh on scroll/resize instead — those are the only things
  // that can move a button without the pointer moving.
  const refresh = () => buttons.forEach((b) => { b.box = b.btn.getBoundingClientRect(); });
  refresh();
  window.addEventListener("scroll", refresh, { passive: true });
  window.addEventListener("resize", refresh);
  document.fonts?.ready.then(refresh);

  document.addEventListener("pointermove", (e) => {
    for (const b of buttons) {
      const r = b.box;
      // A hidden or unlaid-out button has a zero rect; re-read it rather than
      // treating its centre as the page origin.
      if (!r || (!r.width && !r.height)) { b.box = b.btn.getBoundingClientRect(); continue; }
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;

      let outside, strength;
      if (b.radial) {
        // A circle of `reach` px around the centre, as the request asked for.
        const dist = Math.hypot(dx, dy);
        if (dist > b.reach) {
          if (b.btn.__pulled) { b.x(0); b.y(0); b.btn.__pulled = false; }
          b.btn.classList.remove("armed");
          continue;
        }
        outside = dist;
        // Squared falloff rather than linear: with a field this wide, a linear
        // ramp left the button already leaning hard out at the boundary. Squaring
        // keeps it nearly still out there and lets the pull build close in, so it
        // reads as "wakes up" rather than "dragged".
        const t = 1 - dist / b.reach;
        strength = t * t;
      } else {
        // Distance past the button's edge, per axis. Subtracting the half-extents
        // is what makes the field hug the button instead of a radius from centre.
        const outX = Math.abs(dx) - r.width / 2;
        const outY = Math.abs(dy) - r.height / 2;
        if (outX > b.reach || outY > b.reach) {
          if (b.btn.__pulled) { b.x(0); b.y(0); b.btn.__pulled = false; }
          b.btn.classList.remove("armed");
          continue;
        }
        // Fade the pull in over the field instead of switching it on at a
        // constant strength: the raw offset at the edge is already ~20px, so a
        // hard cutoff made the button jump the moment the cursor crossed the
        // boundary. The falloff uses the further-out axis, so approaching
        // diagonally eases in rather than snapping on the first axis in range.
        outside = Math.max(outX, outY);
        strength = 1 - Math.max(0, outside) / b.reach;
      }
      // `armed` drives the reveal for buttons that stay hidden until approached.
      // Set from the same reach test the pull uses, so a button that is drawn
      // toward the cursor is exactly the one that becomes visible.
      if (b.btn.classList.contains("banner-btn")) b.btn.classList.add("armed");
      b.x(dx * MAGNET_PULL * strength);
      b.y(dy * MAGNET_PULL_Y * strength);
      b.btn.__pulled = true;
    }
  }, { passive: true });

  // Leaving the window entirely must release every button.
  document.addEventListener("pointerleave", () => {
    buttons.forEach((b) => {
      if (b.btn.__pulled) { b.x(0); b.y(0); b.btn.__pulled = false; }
      b.btn.classList.remove("armed");
    });
  });
}

function splitHero(el, big) {
  const split = SplitText.create(el, {
    type: "lines,chars",
    autoSplit: true,
    mask: "chars",
    onSplit(self) {
      return gsap.from(self.chars, {
        yPercent: 120,
        stagger: big ? 0.028 : 0.02,
        duration: big ? 1.1 : 0.8,
        ease: "power4.out",
      });
    },
  });
  gsap.set(el, { autoAlpha: 1 });
  return split;
}

function wordScrub(el) {
  const split = SplitText.create(el, {
    type: "words",
    autoSplit: true,
    wordsClass: "word",
    onSplit(self) {
      const HIGHLIGHTS = ["仓库", "星标", "评论", "搜索", "FileHub", "文件"];
      self.words.forEach((w) => {
        if (HIGHLIGHTS.some((h) => w.textContent.includes(h))) w.classList.add("hl");
      });
      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: el.closest("section") || el,
          start: "clamp(top 75%)",
          end: "clamp(bottom 60%)",
          scrub: 0.6,
        },
      });
      tl.to(self.words, { opacity: 1, stagger: 0.06, ease: "none" });
      return tl;
    },
  });
  gsap.set(el, { autoAlpha: 1 });
  return split;
}

/* Entrance reveals.
   Official gsap-scrolltrigger guidance applied here:
   - never mix scrub and toggleActions on one trigger
   - create triggers top-to-bottom, or assign refreshPriority, so pin/measure
     order stays correct when the page reflows
   - `once: true` only kills a trigger after its END is reached, so elements
     already past the start point never fire — hence the explicit pass below */
function batchReveal(selector, y = 40, priority = 0) {
  const els = gsap.utils.toArray(selector);
  if (!els.length) return;
  gsap.set(els, { y, autoAlpha: 0 });
  ScrollTrigger.batch(els, {
    start: "top 88%",
    refreshPriority: priority,
    onEnter: (batch) =>
      gsap.to(batch, { autoAlpha: 1, y: 0, stagger: 0.08, duration: 0.7, ease: "power3.out", overwrite: true }),
  });
}

/* Reveal anything currently on screen. Runs after ScrollSmoother exists,
   because the smoother's transform changes getBoundingClientRect results. */
function revealVisibleNow() {
  const vh = window.innerHeight;
  document.querySelectorAll(".js-card, .js-reveal, .file-row").forEach((el) => {
    if (gsap.getProperty(el, "opacity") !== 0) return;
    const r = el.getBoundingClientRect();
    // Bottom-of-viewport cards count too: at the very bottom of the page the
    // sticky sidebar never crosses a "top 88%" line, so a strict test hides it.
    if (r.top < vh && r.bottom > -200) {
      gsap.to(el, { autoAlpha: 1, y: 0, duration: 0.6, ease: "power3.out", overwrite: true });
    }
  });
}

/* Anything that never fires — off-screen sticky sidebars, elements below the
   fold at the very end of the page — is revealed once the user has stopped
   scrolling, so no content can remain invisible. */
function revealAllRemaining() {
  document.querySelectorAll(".js-card, .js-reveal, .file-row").forEach((el) => {
    if (gsap.getProperty(el, "opacity") === 0) {
      gsap.set(el, { autoAlpha: 1, y: 0, clearProps: "transform" });
    }
  });
}

function initCounters() {
  document.querySelectorAll(".stat-num[data-count]").forEach((el) => {
    const end = parseInt(el.dataset.count, 10) || 0;
    if (!end) { el.textContent = "0"; return; }
    const obj = { v: 0 };
    gsap.to(obj, {
      v: end,
      duration: 1.6,
      ease: "power2.out",
      delay: 0.6,
      onUpdate: () => { el.textContent = Math.round(obj.v).toLocaleString(); },
    });
  });
}

function initMarquee() {
  const root = document.getElementById("marquee");
  const track = document.getElementById("marquee-track");
  const viewport = document.getElementById("marquee-viewport");
  if (!root || !track || !viewport) return;
  const base = track.querySelector(".marquee-set");
  if (!base) return;

  const playBtn = document.getElementById("marquee-play");
  const dotsEl = document.getElementById("marquee-dots");

  // A soft highlight travels along the row behind the label it is passing —
  // the same behaviour as Apple's media-card gallery pill. It is one element
  // that chases the item nearest the centre, rather than per-item backgrounds.
  // Entrance: a round chip pops out of the centre, then the bar widens around
  // it — the same choreography as Apple's media-card gallery.
  const pill = root.querySelector(".marquee-pill");
  const intro = document.createElement("span");
  intro.className = "marquee-intro";
  intro.setAttribute("aria-hidden", "true");
  pill.appendChild(intro);

  const items = () => [...track.querySelectorAll(".marquee-set:first-child .marquee-item")];
  const PAGE_SIZE = 6;
  const pageCount = Math.max(1, Math.ceil(items().length / PAGE_SIZE));
  let page = 0;

  // The set must be wider than the viewport or the loop shows a gap.
  const ensureWidth = () => {
    track.querySelectorAll(".marquee-set").forEach((el, i) => { if (i > 0) el.remove(); });
    const viewportW = viewport.clientWidth || window.innerWidth;
    const setW = base.scrollWidth;
    if (!setW) return 0;
    const copies = Math.max(2, Math.ceil((viewportW * 2) / setW) + 1);
    for (let i = 1; i < copies; i++) {
      const clone = base.cloneNode(true);
      clone.setAttribute("aria-hidden", "true");
      track.appendChild(clone);
    }
    return setW;
  };

  let setWidth = ensureWidth();
  let tween = null;
  let paused = false;

  const start = () => {
    if (tween) tween.kill();
    if (!setWidth || paused) return;
    tween = gsap.to(track, {
      x: -setWidth, ease: "none", duration: setWidth / 42, repeat: -1,
    });
    registerAmbient({ pause: () => tween.pause(), resume: () => tween.resume() });
  };

  /* ---- dots ---- */
  const buildDots = () => {
    dotsEl.innerHTML = "";
    for (let i = 0; i < pageCount; i++) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "marquee-dot" + (i === page ? " current" : "");
      dot.setAttribute("role", "tab");
      dot.setAttribute("aria-selected", String(i === page));
      dot.setAttribute("aria-label", `第 ${i + 1} 组`);
      dot.addEventListener("click", () => goToPage(i));
      dotsEl.appendChild(dot);
    }
  };

  const goToPage = (i) => {
    page = i;
    const list = items();
    const target = list[i * PAGE_SIZE];
    if (tween) tween.kill();
    if (target) {
      const vpRect = viewport.getBoundingClientRect();
      const r = target.getBoundingClientRect();
      const dx = r.left - vpRect.left - 24;
      gsap.to(track, {
        x: `-=${dx}`, duration: 0.6, ease: "power3.inOut",
        onComplete: () => { if (!paused) start(); },
      });
    } else if (!paused) {
      start();
    }
    dotsEl.querySelectorAll(".marquee-dot").forEach((d, idx) => {
      d.classList.toggle("current", idx === i);
      d.setAttribute("aria-selected", String(idx === i));
    });
    const dot = dotsEl.querySelectorAll(".marquee-dot")[i];
    if (dot) gsap.fromTo(dot, { scale: 0.7 }, { scale: 1, duration: 0.4, ease: "back.out(2.5)" });
  };

  const setPaused = (v) => {
    paused = v;
    root.classList.toggle("paused", v);
    playBtn.setAttribute("aria-label", v ? "继续滚动" : "暂停滚动");
    if (v) { if (tween) tween.pause(); }
    else start();
  };

  playBtn.addEventListener("click", () => setPaused(!paused));

  /* ---- hover: slow down and highlight the item under the cursor ---- */
  viewport.addEventListener("pointerleave", () => {
    if (tween) gsap.to(tween, { timeScale: 1, duration: 0.4 });
  });
  viewport.addEventListener("pointerenter", () => {
    if (tween) gsap.to(tween, { timeScale: 0.15, duration: 0.4 });
  });
  viewport.addEventListener("click", (e) => {
    const el = e.target.closest(".marquee-item");
    if (el) gsap.fromTo(el, { scale: 0.92 }, { scale: 1, duration: 0.4, ease: "back.out(2.4)" });
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const wasPaused = paused;
      if (tween) tween.kill();
      setWidth = ensureWidth();
      paused = false;
      start();
      if (wasPaused) setPaused(true);
    }, 250);
  });

  /* ---- entrance ----
     Choreography taken from Apple's media-card gallery on the iPhone product
     page (measured off that page's own per-frame transforms, not guessed):
     the pill opens from a near-point to full width as the main beat, the round
     play button slides in from the left, and the dot pager slides in from the
     right — all three in parallel, with the pill's growth as the spine of the
     timeline. Apple drives it from scroll progress; ours fires once when the
     pill reaches the viewport, so the same states are laid out on a timeline
     instead. */
  const ENTRANCE = {
    open: 1.15,        // s — pill grows from a point to its full width
    openEase: "power3.inOut",
    slide: 0.7,        // s — button and dots travel in
    slideEase: "power3.out",
    dotFrom: 34,       // px the dot pager starts to the right
    btnFrom: -44,      // px the play button starts to the left
  };

  // How far below its resting place the Apple-style bar starts.
  //
  // This is measured against the SCREEN, not the pill: the row rests about 90px
  // above the bottom of the hero, so a rise of 64px only moved it from one spot
  // in mid-air to another — it never reached the bottom edge, which is why it
  // read as "fading in slightly lower" rather than "popping up from the bottom".
  // The start offset is computed at run time as (distance to the viewport
  // bottom + the pill's own height), so the bar begins fully below the fold and
  // travels in from off-screen. A floor keeps it from collapsing on a very tall
  // window where the pill happens to sit close to the edge already.
  const PILL_RISE_MIN = 96;

  /* Skip straight to the finished state. Used when the entrance is switched
     off in settings, and as the reduced-motion and interruption path: the pill
     must still end up visible and clickable, which is what `entered` is for (it
     is what fades the dots in and clears the entering state).
     Declared before playEntrance because playEntrance references it — as a
     callback that would work either way, but keeping every user of a function
     after its definition is the rule this file follows to stay clear of the
     temporal dead zone. */
  /* The hero clips its overflow, which is what the glow gradients need at rest
     but is fatal to a bottom-edge entrance: the pill starts below the fold, and
     with the clip in place the travelling part was cut off, so the bar looked
     like it was appearing in place. Both helpers below toggle the clip and the
     pill's entering state together so the two can never drift apart. */
  const beginEntrance = () => {
    pill.classList.add("entering");
    document.body.classList.add("pill-entering");
  };
  const endEntrance = () => {
    pill.classList.remove("entering");
    document.body.classList.remove("pill-entering");
  };

  const showPillFinal = () => {
    endEntrance();
    pill.classList.add("entered");
    gsap.set([pill, intro, pill.querySelector(".marquee-play"),
              pill.querySelector(".marquee-dots"),
              pill.querySelector(".marquee-viewport")],
             { clearProps: "width,opacity,scale,x,y,top,visibility" });
    revealVisibleNow();
  };

  const playEntrance = () => {
    const playEl = pill.querySelector(".marquee-play");
    const dots = pill.querySelector(".marquee-dots");
    const vp = pill.querySelector(".marquee-viewport");
    beginEntrance();
    const fullWidth = pill.getBoundingClientRect().width;

    const tl = gsap.timeline({
      onComplete: () => {
        endEntrance();
        pill.classList.add("entered");
        gsap.set([pill, intro, playEl, dots, vp], { clearProps: "width,opacity,scale,x,y,top,visibility" });
        revealVisibleNow();
      },
      // A killed timeline would otherwise leave the pill frozen mid-open with
      // its controls half-faded, so an interruption settles it instead.
      onInterrupt: showPillFinal,
    });

    // "slide" was this style's earlier value, before it was rebuilt from
    // Apple's own parameters; treat a stored "slide" as "apple" so an existing
    // localStorage value does not silently fall through to the other branch.
    const style = getSetting("pillStyle");
    if (style === "apple" || style === "slide") {
      /* Style 2 — the Apple media-card gallery entrance, with the three
         physical qualities the design called for: an elastic stretch, a rise
         out of the bottom edge, and inertial settling.

         Apple's own cues are still the skeleton (read from its stylesheet):
           --aap-background-transition-duration: 250ms
           --dotnav-opacity-delay:               740ms  (+100ms fade)
           --playpause-opacity-delay:            940ms  (+100ms fade)
           --playpause-scale-delay:              940ms  (+200ms scale)

         What is added on top, and why each easing is what it is:
           * The pill stretches past its final width and settles back. That
             overshoot is `back.out` on the width, not `elastic` — elastic
             oscillates several times and on a 1180px bar that reads as a wobble,
             while one overshoot reads as a stretch.
           * The whole bar rises from PILL_RISE below and fades in on
             `power4.out`, which is heavily front-loaded: most of the travel
             happens early and the last stretch is slow. That is the inertia —
             it arrives fast and brakes, rather than sliding at a constant rate.
           * The two controls keep Apple's staggered cues and pop in on
             `back.out`, so they land with the same spring the bar has. */
      const beat = (ms) => ms / 1000;
      gsap.set(intro, { autoAlpha: 0, scale: 0.01 });
      gsap.set([playEl, dots], { scale: 0.5 });
      gsap.set(vp, { autoAlpha: 0 });

      /* Two stages, strictly in sequence — not overlapping.

         The previous version ran the width tween from t=0 alongside the rise,
         which is what produced the "jumps down, then comes back up" artefact:
         the bar was being widened from a 56px stub while it was also travelling
         up from below the fold, and since a width change on a centred flex item
         grows it from the middle, the two motions fought each other and read as
         a stumble rather than an entrance.

         Stage A — emerge. The bar is still a 56px stub and nothing but its y
         position changes: it rises from fully below the viewport up to its
         resting place, on `power3.out` so it launches quickly out of the bottom
         edge and coasts. That coast is the inertia.
         Stage B — unfold. Only once the bar has arrived does it open from the
         stub to its full width, centred, with a slight `back.out` overshoot so
         the stretch is visible. The controls then land on Apple's cues, which
         are counted from the END of stage A because that is when the bar
         becomes a bar. */
      // How far to start below, so the bar begins entirely outside the viewport.
      //
      // Measured against the pill's CURRENT on-screen top, not derived from the
      // hero's geometry: the row is centred in a flex column whose padding the
      // entrance itself changes, so any arithmetic on the layout is circular.
      // `viewport height − current top` is exactly the distance that puts the
      // pill's top edge on the bottom edge of the screen; the extra height puts
      // the whole element past it. A floor covers the case where the pill is
      // already near the fold.
      const startTop = pill.getBoundingClientRect().top;
      const rise = Math.max(PILL_RISE_MIN,
        Math.ceil(window.innerHeight - startTop + pill.getBoundingClientRect().height));

      /* The travel is done with `top` on a relatively-positioned element.
         Two earlier attempts failed for different reasons:
           - `y`/translateY: the pill sits inside #smooth-content, the
             ScrollSmoother wrapper that rewrites its own transform every frame,
             and the transform GSAP wrote on this descendant was not the one
             that got painted. The inline style read `translate(0px, 85.8px)`
             while the computed transform was `matrix(1,0,0,1,0,13.9)`, and on
             other frames the two moved in opposite directions.
             `force3D:false` did not change it.
           - `marginTop`: a margin in a centred flex column is partly absorbed
             by the column re-centring itself — 148px of margin moved the bar 74.
             Reserving padding to compensate then shifted the row's resting
             place, which broke the distance calculation.
         `top` does neither: it is a paint-time offset that takes the element out
         of flow, so the distance written is the distance moved, and nothing
         else in the hero reacts to it. */
      gsap.set(pill, { top: rise, autoAlpha: 0, width: 56 });

      const EMERGE = 0.62;   // s — stage A
      const UNFOLD = 0.60;   // s — stage B

      /* The fade runs across most of the rise rather than a quick blip at the
         start, so the bar is still gaining opacity as it clears the bottom edge
         — that reads as arriving out of the dark below the fold rather than as
         a hard cut-in. `power1.out` keeps it ahead of the travel early on and
         lets it finish before the unfold begins. */
      tl.fromTo(pill,
        { autoAlpha: 0 },
        { autoAlpha: 1, duration: 0.5, ease: "power1.out" }, 0)
        // A: travel only. `power3.out` = fast off the bottom edge, long settle.
        .to(pill, { top: 0, duration: EMERGE, ease: "power3.out" }, 0)
        // B: open. Starts exactly when A ends, so the bar is never both moving
        // and changing width.
        .fromTo(pill,
          { width: 56 },
          { width: fullWidth, duration: UNFOLD, ease: "back.out(1.4)" }, EMERGE)
        // The controls are counted from the end of the unfold, since a 56px
        // stub has no room for them — Apple's 740/940ms are relative to its own
        // bar being present, which here is the moment the unfold completes.
        .fromTo(playEl,
          { autoAlpha: 0 },
          { autoAlpha: 1, duration: beat(100), ease: "power1.out" }, EMERGE + beat(740))
        .fromTo(playEl,
          { scale: 0.5 },
          { scale: 1, duration: beat(320), ease: "back.out(2.4)" }, EMERGE + beat(740))
        .fromTo(dots,
          { autoAlpha: 0 },
          { autoAlpha: 1, duration: beat(100), ease: "power1.out" }, EMERGE + beat(540))
        .fromTo(dots,
          { scale: 0.5 },
          { scale: 1, duration: beat(320), ease: "back.out(2.4)" }, EMERGE + beat(540))
        .to(vp, { autoAlpha: 1, duration: beat(260), ease: "power3.out" }, EMERGE + beat(500));
      return;
    }

    /* Style 1 — expand from the centre (the default). A seed pops in, the bar
       grows out of it, and the two end controls travel in as it finishes
       opening so the width change and the arrivals read as one motion.
       `power3.inOut` matches the symmetric feel of Apple's scroll-driven ramp:
       slow to leave the point, slow to settle. */
    tl.fromTo(intro,
      { scale: 0.01, autoAlpha: 0 },
      { scale: 1, autoAlpha: 1, duration: 0.34, ease: "back.out(2.2)" })
      .fromTo(pill,
        { width: 56 },
        { width: fullWidth, duration: ENTRANCE.open, ease: ENTRANCE.openEase }, "-=0.16")
      .fromTo(playEl,
        { x: ENTRANCE.btnFrom, autoAlpha: 0 },
        { x: 0, autoAlpha: 1, duration: ENTRANCE.slide, ease: ENTRANCE.slideEase }, "-=0.62")
      .fromTo(dots,
        { x: ENTRANCE.dotFrom, autoAlpha: 0 },
        { x: 0, autoAlpha: 1, duration: ENTRANCE.slide, ease: ENTRANCE.slideEase }, "<")
      .to(vp, { autoAlpha: 1, duration: 0.42 }, "<0.1")
      .to(intro, { autoAlpha: 0, scale: 0.4, duration: 0.3, ease: "power2.in" },
          `-=${ENTRANCE.open - 0.2}`);
  };

  buildDots();
  if (getSetting("pillIntro") === "on") {
    let played = false;
    const playOnce = () => {
      if (played) return;
      played = true;
      playEntrance();
    };
    // If the pill is already on screen, play immediately.
    if (root.getBoundingClientRect().top < window.innerHeight) {
      playOnce();
    } else {
      // Off screen at load (a short viewport, or the hero pushed down), so wait
      // for it to arrive rather than animating where nobody can see it.
      ScrollTrigger.create({
        trigger: root,
        start: "top 92%",
        once: true,
        onEnter: playOnce,
      });
      /* Dead-man switch. Waiting here means the pill is parked in its start
         state — 56px wide, fully transparent, and pushed below the fold — so if
         the trigger never fires (a viewport collapse, a ScrollTrigger killed by
         a settings rebuild, a refresh that lands between boundaries) it would
         stay invisible and unclickable forever. This settles it into the
         finished state instead of leaving a permanently missing control.
         The check is on `played`, not on a class, so it stands no matter which
         branch left the pill parked. */
      setTimeout(() => { if (!played) showPillFinal(); }, 4000);
    }
  } else {
    showPillFinal();
  }

  start();
}

function initAnchorLinks() {
  document.querySelectorAll(".scroll-down").forEach((a) => {
    a.addEventListener("click", (e) => {
      const hash = a.getAttribute("href");
      if (hash && hash.startsWith("#")) { e.preventDefault(); scrollToTarget(hash); }
    });
  });
}

function initStarButton() {
  const btn = document.getElementById("star-btn");
  if (!btn) return;
  const repoId = btn.dataset.repoId;
  const countEl = document.getElementById("star-count");
  const icon = btn.querySelector(".star-icon");
  btn.addEventListener("click", async () => {
    try {
      const res = await fetch(`/api/star/${repoId}`, { method: "POST" });
      if (res.status === 401) { toast("请先登录"); return; }
      const data = await res.json();
      countEl.textContent = data.count;
      icon.textContent = data.starred ? "★" : "☆";
      btn.classList.toggle("btn-green", data.starred);
      btn.classList.toggle("btn-outline", !data.starred);
      gsap.fromTo(btn, { scale: 0.92 }, { scale: 1, duration: 0.5, ease: "elastic.out(1, 0.45)" });
      if (data.starred) burst(btn);
      toast(data.starred ? "已加星 ⭐" : "已取消星标");
    } catch { toast("网络错误，请重试"); }
  });
}

function burst(btn) {
  for (let i = 0; i < 10; i++) {
    const p = document.createElement("span");
    p.textContent = "✦";
    p.style.cssText = "position:absolute;pointer-events:none;font-size:12px;color:#0ae448;left:50%;top:50%;";
    btn.style.position = "relative";
    btn.appendChild(p);
    const angle = (i / 10) * Math.PI * 2;
    gsap.to(p, {
      x: Math.cos(angle) * 46, y: Math.sin(angle) * 30,
      autoAlpha: 0, scale: gsap.utils.random(0.6, 1.3),
      duration: 0.7, ease: "power2.out", onComplete: () => p.remove(),
    });
  }
}

function initComments() {
  const form = document.getElementById("comment-form");
  if (!form) return;
  const input = document.getElementById("comment-input");
  const list = document.getElementById("comment-list");
  const repoId = form.dataset.repoId;
  const myName = document.body.dataset.me || "";

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) { toast("请输入内容"); return; }
    if (!repoId) { toast("页面数据异常，请刷新重试"); return; }

    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const res = await fetch(`/api/comment/${repoId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast(err.detail || "发表失败");
        return;
      }
      const data = await res.json();

      // Build the same markup the server renders, so a freshly posted comment
      // is indistinguishable from a reloaded one (edit/delete included).
      const node = document.createElement("div");
      node.className = "comment";
      node.dataset.commentId = data.id;
      node.dataset.author = data.username;
      node.dataset.mine = data.username === myName ? "1" : "0";

      // Mirror the server-rendered markup: use the real avatar when set.
      let avatar;
      if (data.avatar) {
        avatar = document.createElement("img");
        avatar.className = "avatar-img";
        avatar.src = data.avatar;
        avatar.alt = "";
      } else {
        avatar = document.createElement("span");
        avatar.className = "avatar";
        avatar.textContent = data.username.slice(0, 1).toUpperCase();
      }

      const bd = document.createElement("div");
      bd.className = "comment-body";
      const meta = document.createElement("div");
      meta.className = "comment-meta";
      const link = document.createElement("a");
      link.href = `/u/${data.username}`;
      link.textContent = data.username;
      const time = document.createElement("span");
      time.className = "comment-time";
      time.textContent = data.created_at;
      meta.append(link, time);
      const para = document.createElement("p");
      para.className = "comment-text";
      para.textContent = data.body;
      bd.append(meta, para);

      // Actions live inside the bubble, pinned to its bottom-right corner —
      // matching the server-rendered markup.
      if (data.username === myName) {
        const actions = document.createElement("div");
        actions.className = "comment-actions";
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "text-btn comment-edit";
        edit.textContent = "编辑";
        const sep = document.createElement("span");
        sep.className = "action-sep";
        sep.textContent = "|";
        const del = document.createElement("button");
        del.type = "button";
        del.className = "text-btn comment-del";
        del.textContent = "删除";
        actions.append(edit, sep, del);
        bd.appendChild(actions);
      }
      node.append(avatar, bd);

      document.getElementById("comment-empty")?.remove();
      list.prepend(node);
      gsap.from(node, { autoAlpha: 0, y: -16, duration: 0.5, ease: "back.out(1.6)" });

      const label = document.querySelector(".comments .readme-title");
      if (label) {
        const m = label.textContent.match(/（(\d+)）/);
        if (m) label.textContent = label.textContent.replace(`（${m[1]}）`, `（${+m[1] + 1}）`);
      }
      input.value = "";
      ScrollTrigger.refresh();
      toast("评论已发表 💬");
    } catch {
      toast("网络错误，请重试");
    } finally {
      btn.disabled = false;
    }
  });
}

function initUpload() {
  const form = document.getElementById("upload-form");
  if (!form) return;
  const input = document.getElementById("file-input");
  const pick = document.getElementById("upload-pick");
  const progress = form.querySelector(".upload-progress");
  const bar = form.querySelector(".upload-bar-fill");
  const pct = form.querySelector(".upload-pct");
  pick.addEventListener("click", () => input.click());
  form.addEventListener("dragover", (e) => { e.preventDefault(); form.classList.add("dragover"); });
  form.addEventListener("dragleave", () => form.classList.remove("dragover"));
  form.addEventListener("drop", (e) => {
    e.preventDefault();
    form.classList.remove("dragover");
    if (e.dataTransfer.files.length) {
      input.files = e.dataTransfer.files;
      submit();
    }
  });
  input.addEventListener("change", () => { if (input.files.length) submit(); });

  function submit() {
    const fd = new FormData();
    [...input.files].forEach((f) => fd.append("files", f));
    progress.hidden = false;
    gsap.set(progress, { autoAlpha: 1 });
    const xhr = new XMLHttpRequest();
    xhr.open("POST", form.action);
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) {
        const p = Math.round((e.loaded / e.total) * 100);
        bar.style.width = `${p}%`;
        pct.textContent = `${p}%`;
      }
    });
    xhr.addEventListener("load", () => {
      if (xhr.status < 400) location.reload();
      else toast("上传失败，请重试");
    });
    xhr.addEventListener("error", () => toast("网络错误，上传失败"));
    xhr.send(fd);
  }
}

function initPreview() {
  const modal = document.getElementById("preview-modal");
  if (!modal) return;
  const content = document.getElementById("preview-content");
  const nameEl = document.getElementById("preview-name");
  const dl = document.getElementById("preview-download");

  function open(a) {
    const url = a.dataset.preview;
    const mime = a.dataset.mime || "";
    nameEl.textContent = a.dataset.path || "";
    dl.href = a.getAttribute("href");
    content.innerHTML = "";
    if (mime.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = url; img.alt = a.dataset.path || "";
      content.appendChild(img);
    } else if (mime.startsWith("video/")) {
      const v = document.createElement("video");
      v.src = url; v.controls = true; v.preload = "metadata";
      content.appendChild(v);
    } else if (mime.startsWith("audio/")) {
      const au = document.createElement("audio");
      au.src = url; au.controls = true;
      content.appendChild(au);
    } else if (mime === "application/pdf") {
      const f = document.createElement("iframe");
      f.src = url;
      content.appendChild(f);
    } else if (mime.startsWith("text/") || mime === "application/json") {
      fetch(url).then((r) => r.text()).then((t) => {
        const pre = document.createElement("pre");
        pre.textContent = t.slice(0, 200_000);
        content.appendChild(pre);
      });
    } else {
      content.innerHTML = '<p style="color:var(--muted)">此类型不支持在线预览，请下载查看。</p>';
    }
    modal.hidden = false;
    gsap.fromTo(modal.querySelector(".preview-backdrop"), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.3 });
    gsap.fromTo(modal.querySelector(".preview-panel"),
      { autoAlpha: 0, y: 40, scale: 0.96 },
      { autoAlpha: 1, y: 0, scale: 1, duration: 0.45, ease: "power3.out" });
  }

  function close() {
    gsap.to(modal.querySelector(".preview-panel"), {
      autoAlpha: 0, y: 24, scale: 0.97, duration: 0.25, ease: "power2.in",
      onComplete: () => { modal.hidden = true; content.innerHTML = ""; },
    });
    gsap.to(modal.querySelector(".preview-backdrop"), { autoAlpha: 0, duration: 0.25 });
  }

  document.querySelectorAll(".file-name[data-preview]").forEach((a) => {
    a.addEventListener("click", (e) => { e.preventDefault(); open(a); });
  });
  modal.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) close(); });
}

/* The sort control is a themed dropdown rather than a native <select>.
   A native one can only be styled while closed; the open list is an OS overlay
   the page has no reach into, so it stayed a light system sheet on a dark page.
   The real <select> is kept in the DOM as the value store: it stays hidden and
   this only writes to it and fires `change`, so initSortFlip reads it exactly
   as it always did. */
function initFileSortDropdown() {
  const root = document.getElementById("file-sort-dd");
  if (!root) return;
  const native = root.querySelector("#file-sort");
  const button = root.querySelector(".fh-select-btn");
  const valueOut = root.querySelector(".fh-select-value");
  const list = root.querySelector(".fh-select-list");
  const options = [...list.querySelectorAll("[role=option]")];

  // The list is a popover so it renders in the browser's top layer. It used to
  // be an absolutely-positioned child, which the .file-browser card's
  // `overflow: hidden` (there for the rounded corners) cut off at the card's
  // edge — the menu was clipped, not covered. The top layer is not subject to
  // an ancestor's overflow or stacking context, so no z-index can lose to it.
  const canPopover = "showPopover" in HTMLElement.prototype;

  // Without popover support the list is an ordinary element and has to be
  // hidden explicitly at rest. With it, the popover state does the hiding and
  // the `hidden` attribute must stay off — it is not cleared by showPopover()
  // and would hold the menu at 0x0 while the popover reported itself open.
  if (!canPopover) list.hidden = true;

  // With a popover the list is no longer positioned relative to the button, so
  // it is placed against the viewport from the button's rect. Right-aligned to
  // the button, opening downward, flipping up when there is no room below.
  const place = () => {
    const b = button.getBoundingClientRect();
    // Measure now that the list is rendered: a closed popover is display:none
    // and reports height 0, which would place it as if it were empty. The
    // fallback covers the frame before layout has settled.
    const h = list.offsetHeight || (list.children.length * 33 + 12);
    const gap = 7;
    const below = window.innerHeight - b.bottom;
    const above = b.top;
    // Open downward unless the menu would overflow the bottom AND there is
    // genuinely more room above. Comparing only against the viewport bottom
    // left it hanging off the fold when the button sat near it — the earlier
    // check used the same numbers but the threshold (h + 12) was tighter than
    // the menu's own height plus its gap, so it just missed flipping.
    const up = below < h + gap && above > below;
    list.style.top = (up ? b.top - h - gap : b.bottom + gap) + "px";
    list.style.left = "auto";
    list.style.right = (window.innerWidth - b.right) + "px";
  };

  const setOpen = (open) => {
    if (canPopover) {
      // No `hidden` attribute here: a popover's own open/closed state decides
      // visibility, and setting `hidden` as well hid the menu the moment it was
      // shown — it opened (the :popover-open state was set) at 0x0, because the
      // [hidden] rule applied on top of it.
      if (open && !list.matches(":popover-open")) list.showPopover();
      else if (!open && list.matches(":popover-open")) list.hidePopover();
    } else {
      list.hidden = !open;
    }
    if (open) place();
    button.setAttribute("aria-expanded", String(open));
    root.classList.toggle("is-open", open);
  };

  const isOpen = () => (canPopover ? list.matches(":popover-open") : !list.hidden);

  const pick = (option) => {
    native.value = option.dataset.value;
    valueOut.textContent = option.textContent.trim();
    options.forEach((o) => {
      const on = o === option;
      o.classList.toggle("is-selected", on);
      o.setAttribute("aria-selected", String(on));
    });
    setOpen(false);
    button.focus();
    // Launched explicitly: .value = ... does not fire `change`, and the flip
    // animation is listening for exactly that event.
    native.dispatchEvent(new Event("change", { bubbles: true }));
  };

  button.addEventListener("click", (e) => {
    e.preventDefault();
    setOpen(!isOpen());
  });

  options.forEach((option) => {
    option.addEventListener("click", () => pick(option));
  });

  // A popover is dismissed by clicking outside on its own, but the fallback
  // path (no popover support) needs the manual check, and Escape has to close
  // either way.
  document.addEventListener("click", (e) => {
    if (isOpen() && !root.contains(e.target) && !list.contains(e.target)) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) { setOpen(false); button.focus(); }
  });
  // Reposition while the page moves under it; a popover does not follow its
  // anchor by itself.
  window.addEventListener("resize", () => { if (isOpen()) place(); });
  window.addEventListener("scroll", () => { if (isOpen()) place(); }, { passive: true });
}

function initSortFlip() {
  const list = document.getElementById("file-list");
  const select = document.getElementById("file-sort");
  if (!list || !select) return;
  select.addEventListener("change", () => {
    const rows = [...list.querySelectorAll(".file-row")];
    const key = select.value;
    rows.sort((a, b) => {
      if (key === "size") return (+b.dataset.size || 0) - (+a.dataset.size || 0);
      if (key === "date") return (+b.dataset.date || 0) - (+a.dataset.date || 0);
      return (a.dataset.name || "").localeCompare(b.dataset.name || "", "zh-CN");
    });
    const state = Flip.getState(rows, { changes: true });
    rows.forEach((r) => list.appendChild(r));
    Flip.from(state, {
      duration: 0.5, ease: "power2.inOut", absolute: true, stagger: 0.02,
      onComplete: () => ScrollTrigger.refresh(),
    });
  });
}

function initFlash() {
  const msg = document.querySelector(".flash-msg");
  if (!msg) return;
  gsap.from(msg, { autoAlpha: 0, y: -14, duration: 0.5, ease: "power3.out" });
  gsap.to(msg, { autoAlpha: 0, y: -10, delay: 4, duration: 0.4, onComplete: () => msg.remove() });
}

/* ---------------------------------------------------------------- modals */

function fadeIn(el) {
  el.hidden = false;
  gsap.fromTo(el.querySelector(".preview-backdrop, .preview-backdrop[data-confirm-close]"),
    { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25 });
  gsap.fromTo(el.querySelector(".confirm-panel, .preview-panel"),
    { autoAlpha: 0, y: 30, scale: 0.96 },
    { autoAlpha: 1, y: 0, scale: 1, duration: 0.4, ease: "power3.out" });
}

function fadeOut(el, done) {
  gsap.to(el.querySelector(".confirm-panel, .preview-panel"), {
    autoAlpha: 0, y: 20, scale: 0.97, duration: 0.22, ease: "power2.in",
    onComplete: () => { el.hidden = true; done && done(); },
  });
}

/* Ask before a destructive action. Resolves true when confirmed. */
let confirmResolver = null;
function askConfirm(title, text, okLabel) {
  const modal = document.getElementById("confirm-modal");
  if (!modal) return Promise.resolve(window.confirm(text));
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-text").textContent = text;
  document.getElementById("confirm-ok").textContent = okLabel || "确认删除";
  fadeIn(modal);
  return new Promise((resolve) => { confirmResolver = resolve; });
}

function initConfirmModal() {
  const modal = document.getElementById("confirm-modal");
  if (!modal) return;
  const close = (result) => {
    fadeOut(modal, () => {
      if (confirmResolver) { confirmResolver(result); confirmResolver = null; }
    });
  };
  document.getElementById("confirm-ok").addEventListener("click", () => close(true));
  modal.querySelectorAll("[data-confirm-close]").forEach((b) =>
    b.addEventListener("click", () => close(false)));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) close(false);
  });
}

/* ---------------------------------------------------------------- file features */

function initBulkSelect() {
  const selectAll = document.getElementById("select-all");
  const bar = document.getElementById("bulk-bar");
  if (!bar) return;
  const countEl = document.getElementById("bulk-count");
  const checks = () => [...document.querySelectorAll(".row-check")];

  // `hidden` cannot drive a fade: the global [hidden] rule is display:none,
  // which kills the transition. So the bar is hidden with autoAlpha instead,
  // and the markup's `hidden` attribute is dropped right away.
  bar.classList.add("gsap-fade");
  bar.hidden = false;
  gsap.set(bar, { autoAlpha: 0, height: 0, paddingTop: 0, paddingBottom: 0, borderBottomWidth: 0 });
  const sync = () => {
    const picked = checks().filter((c) => c.checked);
    countEl.textContent = `已选 ${picked.length} 项`;
    if (picked.length) {
      // Settle the box metrics immediately, then animate the height. Doing it
      // the other way round lets height:"auto" measure against zero padding.
      gsap.set(bar, { paddingTop: 10, paddingBottom: 10, borderBottomWidth: 1 });
      gsap.fromTo(bar,
        { autoAlpha: 0, height: 0, y: -8 },
        { autoAlpha: 1, height: "auto", y: 0, duration: 0.32, ease: "power3.out",
          overwrite: true });
    } else if (gsap.getProperty(bar, "opacity") !== 0) {
      // Exit: collapse upward and leave no gap. height:0 alone is not enough —
      // the bar's own padding and bottom border still occupy space — so both
      // are animated to zero as well.
      gsap.to(bar, {
        autoAlpha: 0, height: 0, paddingTop: 0, paddingBottom: 0,
        borderBottomWidth: 0, y: -8, duration: 0.24, ease: "power2.in",
        onComplete: () => gsap.set(bar, { y: 0 }),
      });
    }
  };

  checks().forEach((c) => c.addEventListener("change", sync));
  if (selectAll) {
    selectAll.addEventListener("change", () => {
      checks().forEach((c) => { c.checked = selectAll.checked; });
      sync();
    });
  }

  document.getElementById("bulk-delete").addEventListener("click", async () => {
    const ids = checks().filter((c) => c.checked).map((c) => +c.value);
    if (!ids.length) return;
    const ok = await askConfirm("删除所选文件", `将永久删除 ${ids.length} 个文件，此操作不可撤销。`, `删除 ${ids.length} 项`);
    if (!ok) return;
    const res = await fetch(location.pathname + "/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) { toast("删除失败"); return; }
    const data = await res.json();
    const rows = checks().filter((c) => c.checked).map((c) => c.closest(".file-row"));
    gsap.to(rows, {
      autoAlpha: 0, x: 30, duration: 0.3, stagger: 0.04, ease: "power2.in",
      onComplete: () => location.reload(),
    });
    toast(`已删除 ${data.deleted} 个文件`);
  });
}

function initDeleteGuards() {
  document.querySelectorAll(".file-del").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const ok = await askConfirm("删除文件", `确定要删除「${form.dataset.name}」吗？此操作不可撤销。`);
      if (ok) HTMLFormElement.prototype.submit.call(form);
    });
  });

  const repoBtn = document.getElementById("delete-repo-btn");
  if (repoBtn) {
    repoBtn.addEventListener("click", async () => {
      const ok = await askConfirm(
        "删除整个仓库",
        `「${repoBtn.dataset.name}」中的所有文件、评论和星标都会被永久删除，此操作不可撤销。`
      );
      if (!ok) return;
      const form = document.createElement("form");
      form.method = "post";
      form.action = `/r/${repoBtn.dataset.owner}/${repoBtn.dataset.name}/delete`;
      document.body.appendChild(form);
      form.submit();
    });
  }
}

function initFileMeta() {
  const modal = document.getElementById("meta-modal");
  if (!modal) return;
  let currentId = null;
  const close = () => fadeOut(modal);

  document.querySelectorAll(".edit-meta").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentId = btn.dataset.id;
      document.getElementById("meta-file").textContent = btn.dataset.name;
      document.getElementById("meta-tags").value = btn.dataset.tags || "";
      document.getElementById("meta-note").value = btn.dataset.note || "";
      fadeIn(modal);
    });
  });

  modal.querySelectorAll("[data-meta-close]").forEach((b) => b.addEventListener("click", close));
  document.getElementById("meta-save").addEventListener("click", async () => {
    const tags = document.getElementById("meta-tags").value;
    const note = document.getElementById("meta-note").value;
    const res = await fetch(`/file/${currentId}/meta`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags, note }),
    });
    if (!res.ok) { toast("保存失败"); return; }
    close();
    toast("已保存 🏷");
    setTimeout(() => location.reload(), 500);
  });
}

function initFolderRename() {
  document.querySelectorAll(".rename-folder").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const next = window.prompt("文件夹显示名称（只改显示，不动实际路径）", btn.dataset.display);
      if (next === null) return;
      const name = next.trim();
      if (!name) { toast("名称不能为空"); return; }
      const res = await fetch(location.pathname + "/rename-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: btn.dataset.path, display_name: name }),
      });
      if (!res.ok) { toast("重命名失败"); return; }
      toast("已重命名");
      setTimeout(() => location.reload(), 400);
    });
  });
}

function initTypeBars() {
  const fills = document.querySelectorAll(".type-fill[data-pct]");
  if (!fills.length) return;
  const tl = gsap.timeline({
    scrollTrigger: { trigger: fills[0].closest(".side-card"), start: "top 90%" },
  });
  fills.forEach((f, i) => {
    tl.to(f, { width: `${f.dataset.pct}%`, duration: 0.8, ease: "power3.out" }, i * 0.08);
  });
}

function initHeatmap() {
  const map = document.getElementById("heatmap");
  if (!map) return;
  const max = Math.max(1, parseInt(map.dataset.max, 10) || 1);
  const days = [...map.querySelectorAll(".hm-day")];
  const today = new Date().toISOString().slice(0, 10);
  days.forEach((d) => {
    const c = parseInt(d.dataset.count, 10) || 0;
    // A single upload should still read as a visible cell, so level 1 is the
    // floor for any activity; the rest scale against the busiest day.
    const level = c === 0 ? 0 : Math.max(1, Math.min(4, Math.ceil((c / max) * 4)));
    d.classList.remove("lv0", "lv1", "lv2", "lv3", "lv4");
    d.classList.add(`lv${level}`);
    if (d.dataset.date > today) d.classList.add("future");
  });
  // Size the cells so 26 weeks plus gaps fill the card exactly, keeping every
  // cell square. Recomputed on resize because the card width is fluid.
  const fitCells = () => {
    const w = map.clientWidth;
    if (!w) return;
    const weeks = map.querySelectorAll(".hm-week").length || 26;
    const gap = 4;
    // Leave room for the column seams so the last week cannot overflow.
    // Fill the available width: cell size = (available - gaps) / columns, capped
    // only by a sane maximum so the grid never looks sparse on wide screens.
    // Cells are always a whole number of pixels: fractional tiles produce
    // visible seams on non-retina displays. Any width left over is absorbed by
    // the flex container's inter-column spacing, so the leftover gap differs
    // from the row gap by at most a pixel — imperceptible, and a deliberate
    // trade for crisp squares.
    const maxCell = 26;
    const raw = (w - gap * (weeks - 1)) / weeks;
    const cell = Math.max(9, Math.min(maxCell, Math.floor(raw)));
    map.style.setProperty("--hm-cell", cell + "px");
  };
  // Month labels are positioned from the measured column rectangles rather
  // than a computed offset, so they stay aligned whatever the cell size and
  // inter-column spacing end up being.
  const placeMonthTicks = () => {
    const months = document.getElementById("hm-months");
    if (!months) return;
    const weeks = [...map.querySelectorAll(".hm-week")];
    if (!weeks.length) return;
    const base = map.getBoundingClientRect().left;
    months.querySelectorAll(".hm-month-tick").forEach((tick) => {
      const col = parseInt(tick.style.getPropertyValue("--hm-col"), 10) || 0;
      const target = weeks[col];
      if (!target) return;
      tick.style.left = Math.round(target.getBoundingClientRect().left - base) + "px";
    });
  };
  const relayout = () => { fitCells(); placeMonthTicks(); };

  /* ---- activity tooltip ----
     The cells carried a native `title`, which the browser renders in its own
     time, in its own style, and never on a phone. This is the site's own
     tooltip instead: it waits HOVER_DELAY so a pointer merely crossing the grid
     does not spray labels, and it only appears on cells that actually have
     activity — an empty day has nothing worth reporting. */
  const HOVER_DELAY = 200;
  // A hair of slack, only to absorb sub-pixel rounding at a cell's edge. It is
  // deliberately small: the gap between cells is its own state now (see
  // cellAt), so the gap no longer needs covering here, and a large value would
  // let an active cell steal the edge of the empty cell beside it.
  const CELL_SLACK = 1;
  let tip = null;
  let tipTimer = null;
  let tipCell = null;
  let tipShowing = false;
  let cellBoxes = [];
  let gridBox = null;

  const ensureTip = () => {
    if (tip) return tip;
    tip = document.createElement("div");
    tip.className = "hm-tip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    document.body.appendChild(tip);   // body, not the card: the card clips overflow
    return tip;
  };

  const placeTip = (cell) => {
    const t = ensureTip();
    const r = cell.getBoundingClientRect();
    const box = t.getBoundingClientRect();
    // Sit above the cell, centred, and keep the whole box on screen — a cell in
    // the first or last column would otherwise push it off the edge.
    let left = r.left + r.width / 2 - box.width / 2;
    left = Math.max(8, Math.min(window.innerWidth - box.width - 8, left));
    let top = r.top - box.height - 8;
    const below = top < 8;
    if (below) top = r.bottom + 8;
    t.style.left = Math.round(left) + "px";
    t.style.top = Math.round(top) + "px";
    t.classList.toggle("below", below);
  };

  const showTip = (cell) => {
    const count = parseInt(cell.dataset.count, 10) || 0;
    if (!count) { hideTip(); return; }
    const t = ensureTip();
    const [, m, d] = (cell.dataset.date || "").split("-");
    t.innerHTML = "";
    const dateEl = document.createElement("span");
    dateEl.className = "hm-tip-date";
    dateEl.textContent = `${+m} 月 ${+d} 日`;
    const countEl = document.createElement("span");
    countEl.className = "hm-tip-count";
    countEl.textContent = `${count} 个文件`;
    t.append(dateEl, countEl);
    t.hidden = false;
    placeTip(cell);
    // The fade is keyed off a counter, not off hidden/visible state: the old
    // version set `hidden` from an onComplete callback, so a quick move between
    // two cells could land the previous hide's completion AFTER the new show
    // and blank the tooltip that had just appeared. That was the bug where it
    // simply never showed.
    tipShowing = true;
    gsap.killTweensOf(t);
    gsap.fromTo(t, { autoAlpha: 0, y: 4 }, { autoAlpha: 1, y: 0, duration: 0.18, ease: "power2.out" });
  };

  const hideTip = () => {
    clearTimeout(tipTimer);
    tipTimer = null;
    tipCell = null;
    if (!tip || !tipShowing) return;
    tipShowing = false;
    const t = tip;
    gsap.killTweensOf(t);
    gsap.to(t, {
      autoAlpha: 0, y: 4, duration: 0.14, ease: "power2.in",
      onComplete: () => { if (!tipShowing) t.hidden = true; },
    });
  };

  /* The cell under a point, by geometry rather than by event target.
     `e.target` is whichever element is painted there, and the grid has gaps
     (the `.hm-week` background between cells) plus the month ticks and legend
     sitting in the same container — all of which report no cell, which made the
     tooltip dismiss itself the instant the cursor crossed a gap. Testing the
     coordinates instead means the whole grid rectangle resolves to its nearest
     cell, so travel across it is continuous. The rects are cached because this
     runs on every pointer move, and rebuilt whenever the layout can change. */
  const measureCells = () => {
    const g = map.getBoundingClientRect();
    gridBox = { l: g.left, t: g.top, r: g.right, b: g.bottom };
    cellBoxes = [...map.querySelectorAll(".hm-day")].map((el) => {
      const r = el.getBoundingClientRect();
      return { el, l: r.left, t: r.top, r: r.right, b: r.bottom };
    }).filter((c) => c.r > c.l && c.b > c.t);
  };

  const cellAt = (x, y) => {
    // Only resolve inside the grid's own rectangle. Outside it the pointer is
    // not over the heatmap at all, which is the one case that dismisses.
    if (!gridBox || x < gridBox.l - CELL_SLACK || x > gridBox.r + CELL_SLACK ||
        y < gridBox.t - CELL_SLACK || y > gridBox.b + CELL_SLACK) {
      return null;                       // outside the grid
    }
    for (const c of cellBoxes) {
      if (x >= c.l - CELL_SLACK && x <= c.r + CELL_SLACK &&
          y >= c.t - CELL_SLACK && y <= c.b + CELL_SLACK) {
        return c.el;                     // a cell (or the gap right beside one)
      }
    }
    // Inside the grid but between cells. Not a cell and not "away" either — the
    // pointer is crossing the few px of gap on its way somewhere. Callers must
    // treat this as "hold", not as "nothing here".
    return undefined;
  };

  map.addEventListener("pointermove", (e) => {
    const inside = cellAt(e.clientX, e.clientY);

    // Three outcomes, and they mean different things:
    //   null      — outside the grid: dismiss.
    //   undefined — in the gap between two cells: hold whatever is showing, so
    //               crossing a gap on the way to the next cell does not blink.
    //   element   — a cell: show its label, or clear if the day is empty.
    if (inside === undefined) return;
    if (inside === null) { hideTip(); return; }
    if (inside === tipCell) return;
    tipCell = inside;

    // An empty day has nothing to report, so the label goes away — this is the
    // case the previous revision got wrong by holding it. Only the gap above
    // holds; a cell that genuinely has no activity must clear.
    const count = parseInt(inside.dataset.count, 10) || 0;
    if (!count) { hideTip(); return; }

    const wasOpen = tipShowing;
    clearTimeout(tipTimer);
    // Once the tooltip is up, moving between active cells is immediate; the
    // delay applies only to the first appearance.
    tipTimer = setTimeout(() => showTip(inside), wasOpen ? 0 : HOVER_DELAY);
  });
  map.addEventListener("pointerleave", hideTip);
  // Scrolling invalidates the cached rects. It must not dismiss the tooltip:
  // ScrollSmoother smooths with transforms, so one wheel flick keeps firing
  // `scroll` for hundreds of ms, and treating each as "the cell moved away"
  // killed the label the moment it appeared — the flash seen when the page is
  // still settling as the pointer arrives on the grid.
  // The tooltip is position:fixed, so it has to be re-placed instead of left
  // where it was, or it would drift away from its cell as the page scrolls.
  let viewportRaf = 0;
  const onViewportChange = () => {
    measureCells();
    if (!tipShowing || !tipCell) return;
    if (viewportRaf) return;
    viewportRaf = requestAnimationFrame(() => {
      viewportRaf = 0;
      if (tipShowing && tipCell) placeTip(tipCell);
    });
  };
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("scroll", onViewportChange, { passive: true });
  map.addEventListener("pointerdown", hideTip);

  fitCells();
  placeMonthTicks();
  measureCells();
  window.addEventListener("resize", relayout);
  setTimeout(() => { placeMonthTicks(); measureCells(); }, 400);

  // Animate with `fromTo` and an explicit visible end state so a trigger that
  // never fires cannot leave the grid stuck at scale(0) — the failure mode
  // that made the whole heatmap invisible.
  gsap.fromTo(days,
    { scale: 0, autoAlpha: 0 },
    {
      scale: 1, autoAlpha: 1, duration: 0.4, ease: "back.out(2)",
      stagger: { each: 0.0015, from: "start" },
      scrollTrigger: { trigger: map, start: "top 92%", once: true },
      onComplete: function () { gsap.set(days, { clearProps: "transform" }); },
    });

  // Safety net: if the grid is on screen but the trigger has not run, show it.
  setTimeout(function () {
    const r = map.getBoundingClientRect();
    if (r.top < window.innerHeight && gsap.getProperty(days[0], "scaleX") === 0) {
      gsap.set(days, { scale: 1, autoAlpha: 1, clearProps: "transform" });
    }
  }, 1200);
}

function initAvatarUpload() {
  const manage = document.getElementById("avatar-manage");
  if (!manage) return;

  // One entry point for every avatar action, replacing the separate
  // "remove avatar" button that sat next to it.
  const menu = document.createElement("div");
  menu.className = "avatar-menu";
  menu.hidden = true;
  menu.innerHTML =
    '<button type="button" class="avatar-menu-item" data-act="upload">📁 上传图片并裁剪</button>' +
    '<div class="avatar-menu-sep">使用默认头像</div>' +
    '<div class="avatar-preset-row">' +
    [1,2,3,4,5,6].map((i) =>
      `<button type="button" class="preset-avatar" data-preset="${i}"><img src="/static/img/avatar-${i}.svg" alt=""></button>`
    ).join("") +
    '</div>' +
    '<button type="button" class="avatar-menu-item danger" data-act="remove">🗑 移除头像</button>';
  manage.parentElement.appendChild(menu);

  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.hidden = true;
  manage.parentElement.appendChild(input);

  manage.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    if (!menu.hidden) {
      // Anchored to the button so it stays put while the page scrolls, and
      // lifted above the header so nothing can cover it.
      const r = manage.getBoundingClientRect();
      menu.style.top = Math.round(r.bottom + 10) + "px";
      menu.style.left = Math.round(r.left) + "px";
      gsap.fromTo(menu, { autoAlpha: 0, y: -8, scale: 0.97 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.28, ease: "power3.out" });
    }
  });

  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== manage) menu.hidden = true;
  });

  menu.addEventListener("click", async (e) => {
    const preset = e.target.closest(".preset-avatar");
    if (preset) {
      const res = await fetch("/settings/avatar/preset/" + preset.dataset.preset, { method: "POST" });
      if (!res.ok) { toast("设置失败"); return; }
      window.location.href = "/u/" + document.body.dataset.me + "?msg=" + encodeURIComponent("已更换头像");
      return;
    }
    const act = e.target.closest("[data-act]");
    if (!act) return;
    if (act.dataset.act === "upload") input.click();
    if (act.dataset.act === "remove") {
      menu.hidden = true;
      const form = document.createElement("form");
      form.method = "post";
      form.action = "/settings/avatar/delete";
      document.body.appendChild(form);
      form.submit();
    }
  });

  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { toast("请选择图片文件"); return; }
    const reader = new FileReader();
    reader.onload = () => {
      try { sessionStorage.setItem("fh-avatar-src", reader.result); }
      catch (err) { toast("图片太大，请换一张"); return; }
      menu.hidden = true;
      gsap.to(".profile-avatar-wrap", {
        autoAlpha: 0, scale: 0.96, duration: 0.22, ease: "power2.in",
        onComplete: () => { window.location.href = "/settings/avatar/crop"; },
      });
    };
    reader.readAsDataURL(file);
  });
}

function initFollowButton() {
  const btn = document.getElementById("follow-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/follow/" + btn.dataset.username, { method: "POST" });
      if (res.status === 401) { toast("请先登录"); return; }
      if (!res.ok) { toast("操作失败"); return; }
      const data = await res.json();
      btn.dataset.following = data.following ? "1" : "0";
      btn.classList.toggle("btn-green", data.following);
      btn.classList.toggle("btn-outline", !data.following);
      btn.querySelector(".follow-icon").textContent = data.following ? "✓ 正在关注" : "＋ 关注";
      btn.querySelector(".follow-count").textContent = data.followers;
      const statEl = document.getElementById("follower-count");
      if (statEl) statEl.textContent = data.followers;
      gsap.fromTo(btn, { scale: 0.94 }, { scale: 1, duration: 0.5, ease: "elastic.out(1, 0.5)" });
      toast(data.following ? "已关注 " + btn.dataset.username : "已取消关注");
    } catch { toast("网络错误"); }
  });
}

/* ---------------------------------------------------------------- page setups */

function setupHeaderChrome() {
  ScrollTrigger.create({
    start: 60,
    onToggle: (self) => document.getElementById("site-header").classList.toggle("scrolled", self.isActive),
  });
  gsap.to("#scroll-progress", {
    scaleX: 1, ease: "none",
    scrollTrigger: { scrub: 0.3, start: 0, end: "max" },
  });
}

function setupHome() {
  document.querySelectorAll(".split-hero").forEach((el) => {
    document.fonts.ready.then(() => {
      splitHero(el, true);
      heroStagedEntrance();
    });
  });
  batchReveal(".hero .js-reveal", 24);
  initCounters();
  initMarquee();
  gsap.utils.toArray(".split-why").forEach((el) => {
    document.fonts.ready.then(() => wordScrub(el));
  });
  batchReveal(".js-card", 44);
  // The hero background is the tile field, which runs its own ambient loop
  // (see initHeroTiles) and pauses itself when the tab is hidden or the hero
  // has scrolled out of view.
}

function setupRepo() {
  batchReveal(".js-card", 36);
  batchReveal(".repo-hero .js-reveal", 20);
  document.querySelectorAll(".split-hero-sm").forEach((el) => {
    document.fonts.ready.then(() => splitHero(el, false));
  });
  gsap.utils.toArray(".split-why").forEach((el) => {
    document.fonts.ready.then(() => wordScrub(el));
  });
  batchReveal(".file-row", 18);
  initStarButton();
  initComments();
  initUpload();
  initPreview();
  initSortFlip();
  initFileSortDropdown();
  initConfirmModal();
  initRepoEditor();
  initBulkSelect();
  initDeleteGuards();
  initFileMeta();
  initFolderRename();
  initTypeBars();
}

function setupGeneric() {
  document.querySelectorAll(".split-hero-sm").forEach((el) => {
    document.fonts.ready.then(() => splitHero(el, false));
  });
  gsap.utils.toArray(".split-why").forEach((el) => {
    document.fonts.ready.then(() => wordScrub(el));
  });
  batchReveal(".js-card", 36);
  batchReveal(".js-reveal", 24);
  batchReveal(".repo-hero .stat", 20);
  initAvatarUpload();
  initFollowButton();
  initFollowModal();
  initHeatmap();
  initConfirmModal();
  initDeleteGuards();
}

/* The splash is a first-visit greeting, not a page transition. Playing it on
   every navigation made clicking the header feel like a full reload, so it is
   remembered for the session and replaced by a light entrance afterwards. */
function introSequence(done) {
  const intro = document.getElementById("intro");
  const header = document.getElementById("site-header");
  const seen = sessionStorage.getItem("fh-intro-seen") === "1";

  if (seen) {
    intro?.remove();
    gsap.fromTo(header, { yPercent: -100 }, { yPercent: 0, duration: 0.45, ease: "power3.out" });
    done && done();
    return;
  }
  sessionStorage.setItem("fh-intro-seen", "1");

  // The page work starts as the splash begins to lift, not after it is gone,
  // so the staged headline timing is measured from the moment the home page
  // becomes visible.
  let started = false;
  const startOnce = () => {
    if (started) return;
    started = true;
    done && done();
  };

  const tl = gsap.timeline({
    onComplete: () => { intro.remove(); startOnce(); },
  });
  tl.from(".intro-brand", { autoAlpha: 0, letterSpacing: "0.6em", duration: 0.5, ease: "power2.out" })
    .to(intro, {
      yPercent: -100, duration: 0.7, ease: "power4.inOut",
      onStart: startOnce,
    }, "+=0.25")
    .from(header, { yPercent: -100, duration: 0.5, ease: "power3.out" }, "-=0.35");
}

function showAllInstantly() {
  gsap.set(".js-reveal, .js-card, .split-hero, .split-hero-sm, .split-why, .file-row", { autoAlpha: 1, y: 0 });
  gsap.set(".why-text .word", { opacity: 1 });
}

/* ---------------------------------------------------------------- boot */

function build() {
  mm.kill();
  const page = document.body.dataset.page;

  // Reduced-motion OS setting: instant, calm version (GSAP a11y guide)
  mm.add("(prefers-reduced-motion: reduce)", () => {
    document.getElementById("intro")?.remove();
    showAllInstantly();
    setupHeaderChrome();
    initAnchorLinks();
    initFlash();
  });

  mm.add("(prefers-reduced-motion: no-preference)", (ctx) => {
    const full = motionPref();
    (window.__fhDebug = window.__fhDebug || []).push({ full, t: Date.now() });

    setupHeaderChrome();
    initAnchorLinks();
    initMagnetic();
    initFlash();

    if (!full) {
      document.getElementById("intro")?.remove();
      showAllInstantly();
      return;
    }

    const smoother = ScrollSmoother.create({
      smooth: 1,
      effects: true,
      normalizeScroll: false,
    });

    const pageInit = () => {
      if (page === "home") setupHome();
      else if (page === "repo") setupRepo();
      else setupGeneric();
    };
    introSequence(pageInit);
    ScrollTrigger.refresh();
    // Defer reveal sweeps until the intro timeline has finished: running
    // tweens on the same elements mid-intro interrupts the entrance sequence.
    const afterIntro = () => {
      ScrollTrigger.refresh();
      revealVisibleNow();
    };
    ScrollTrigger.addEventListener("refreshInit", revealVisibleNow);
    setTimeout(afterIntro, 1800);
    setTimeout(afterIntro, 3200);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(afterIntro);
    // Dynamic content (uploads, comments, previews) changes layout — the
    // official skill is explicit that resize is auto-handled but DOM changes
    // are not. Re-measure once the page has fully settled.
    window.addEventListener("load", () => setTimeout(afterIntro, 200));
    // Sticky sidebars at the page end never cross a trigger line. Once
    // scrolling stops, reveal anything still hidden so content cannot be lost.
    let settleTimer;
    const onScrollSettle = () => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(afterIntro, 250);
    };
    window.addEventListener("scroll", onScrollSettle, { passive: true });
    setTimeout(revealAllRemaining, 7000);
    return () => smoother.kill();
  });
}

/* ================= v11: settings panel ================= */

const SETTINGS_DEFAULTS = {
  motion: "on",
  pointer: "on",
  smooth: "on",
  thumbs: "on",
  compact: "off",
  accent: "",
  theme: "system",
  zoom: "80",
  chatWidth: "80",
  pillIntro: "on",
  pillStyle: "apple",
};

function getSetting(key) {
  const v = localStorage.getItem("fh-set-" + key);
  return v === null ? SETTINGS_DEFAULTS[key] : v;
}

function setSetting(key, value) {
  localStorage.setItem("fh-set-" + key, value);
}

/* Apply the theme choice to <html data-theme>.

   "system" is resolved here rather than left to a CSS media query, so the
   markup always carries the theme actually in force. That keeps one source of
   truth for the palette — a media query plus a data attribute is two, and they
   disagree the moment the user picks something other than "system". A
   matchMedia listener re-resolves it while the page is open, so switching the
   OS theme takes effect without a reload. */
const darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function resolveTheme() {
  const choice = getSetting("theme") || "system";
  if (choice === "system") return darkQuery && darkQuery.matches ? "dark" : "light";
  return choice;
}

function applyTheme() {
  const theme = resolveTheme();
  document.documentElement.setAttribute("data-theme", theme);
  // The <meta name="theme-color"> tints the browser chrome; it has to follow.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "light" ? "#f6f7f6" : "#0e100f");
  return theme;
}

if (darkQuery && darkQuery.addEventListener) {
  darkQuery.addEventListener("change", () => {
    if (getSetting("theme") !== "system") return;
    applyTheme();
    // The tile field bakes its palette at build time, so following the OS into
    // the other theme has to rebuild it — otherwise the hero keeps whichever
    // palette was in force when the page loaded.
    initHeroTiles();
  });
}

function applyAppearanceSettings() {
  const accent = getSetting("accent");
  document.body.classList.toggle("has-accent", !!accent);
  if (accent) {
    document.documentElement.style.setProperty("--accent", accent);
  } else {
    document.documentElement.style.removeProperty("--accent");
  }
  // GSAP writes inline styles, so a cleared CSS variable does not undo a
  // colour it already applied. Reset that copy too, and drop inline colours
  // the search box picked up on focus.
  applyAccentToGsap(accent || "#0ae448");
  document.querySelectorAll("#header-search, #header-search button").forEach((el) => {
    el.style.removeProperty("border-color");
    el.style.removeProperty("background-color");
  });
  const sb = document.querySelector(".header-search");
  if (sb) gsap.killTweensOf(sb);

  document.body.classList.toggle("compact", getSetting("compact") === "on");
  document.body.classList.toggle("hide-thumbs", getSetting("thumbs") !== "on");

  // Interface zoom scales the root font size, so rem-based type and spacing
  // grow together while the layout width stays predictable.
  const zoom = parseInt(getSetting("zoom"), 10) || parseInt(SETTINGS_DEFAULTS.zoom, 10);
  document.documentElement.style.fontSize = zoom === 100 ? "" : (16 * zoom / 100) + "px";
  const label = document.getElementById("zoom-label");
  if (label) label.textContent = zoom + "%";

  // Chat card width. Set as a custom property rather than an inline width so
  // the stylesheet keeps ownership of the clamp and the responsive fallback.
  const chatWidth = applyChatWidth();
  const chatLabel = document.getElementById("chat-width-label");
  if (chatLabel) chatLabel.textContent = chatWidth + "%";
}

/* The chat shell is a floating card, so its width is a user setting. Clamped
   here as well as in the markup: a stale localStorage value from an older
   build could otherwise open the card wider than the viewport. */
function clampChatWidth(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return parseInt(SETTINGS_DEFAULTS.chatWidth, 10);
  return Math.max(50, Math.min(80, n));
}

function applyChatWidth() {
  const w = clampChatWidth(getSetting("chatWidth"));
  document.documentElement.style.setProperty("--chat-w", w + "%");
  return w;
}

function initSettingsPanel() {
  const panel = document.getElementById("settings-panel");
  const toggle = document.getElementById("settings-toggle");
  if (!panel || !toggle) return;

  const syncControls = () => {
    panel.querySelectorAll("[data-setting]").forEach((el) => {
      el.checked = getSetting(el.dataset.setting) === "on";
    });
    const accent = getSetting("accent");
    panel.querySelectorAll(".accent-dot").forEach((d) => {
      d.classList.toggle("active", d.dataset.accent === accent);
    });
    // The theme control highlights the stored CHOICE, not the theme in force:
    // picking "system" while the OS is dark must show "system" as selected, not
    // "dark", or the user cannot tell their choice was recorded.
    const themeChoice = getSetting("theme") || "system";
    panel.querySelectorAll(".theme-opt").forEach((o) => {
      const on = o.dataset.themeChoice === themeChoice;
      o.classList.toggle("active", on);
      o.setAttribute("aria-checked", String(on));
    });
    const zoomEl = panel.querySelector("#setting-zoom");
    if (zoomEl) zoomEl.value = getSetting("zoom");
    const chatEl = panel.querySelector("#setting-chat-width");
    if (chatEl) chatEl.value = clampChatWidth(getSetting("chatWidth"));
    const chatLabel = document.getElementById("chat-width-label");
    if (chatLabel) chatLabel.textContent = clampChatWidth(getSetting("chatWidth")) + "%";
    const pillStyle = panel.querySelector("#setting-pill-style");
    if (pillStyle) pillStyle.value = getSetting("pillStyle");
    toggle.classList.toggle("active", !panel.hidden);
  };

  const open = () => {
    panel.hidden = false;
    toggle.classList.add("active");
    toggle.setAttribute("aria-pressed", "true");
    syncControls();
    gsap.fromTo(panel.querySelector(".settings-backdrop"), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.28 });
    gsap.fromTo(panel.querySelector(".settings-drawer"),
      { xPercent: 100 }, { xPercent: 0, duration: 0.45, ease: "power4.out" });
    gsap.from(panel.querySelectorAll(".settings-group, .settings-foot"), {
      autoAlpha: 0, x: 24, duration: 0.4, stagger: 0.06, delay: 0.12, ease: "power3.out",
    });
  };

  const close = () => {
    gsap.to(panel.querySelector(".settings-drawer"), {
      xPercent: 100, duration: 0.32, ease: "power3.in",
    });
    gsap.to(panel.querySelector(".settings-backdrop"), {
      autoAlpha: 0, duration: 0.3,
      onComplete: () => {
        panel.hidden = true;
        toggle.classList.remove("active");
        toggle.setAttribute("aria-pressed", "false");
      },
    });
  };

  toggle.addEventListener("click", () => (panel.hidden ? open() : close()));
  panel.querySelectorAll("[data-settings-close]").forEach((b) => b.addEventListener("click", close));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) close();
  });

  // switches
  panel.querySelectorAll("[data-setting]").forEach((el) => {
    el.addEventListener("change", () => {
      const key = el.dataset.setting;
      setSetting(key, el.checked ? "on" : "off");
      if (key === "motion" || key === "smooth") {
        build();
        // The tile field draws its own still frame when motion is off, so it
        // has to rebuild either way.
        initHeroTiles();
        toast(el.checked ? "已开启" : "已关闭");
      } else if (key === "pointer") {
        if (el.checked) initPointerEffect();
        else destroyPointerEffect();
      } else if (key === "pillIntro") {
        // The entrance is a one-shot, so switching it back on mid-session
        // cannot replay it — reloading the page is what picks it up. Say so
        // rather than leaving the user wondering why nothing moved.
        toast(el.checked ? "已开启，刷新后生效" : "已关闭");
      } else {
        applyAppearanceSettings();
        toast(el.checked ? "已开启" : "已关闭");
      }
    });
  });

  // accent colour
  panel.querySelectorAll(".accent-dot").forEach((dot) => {
    dot.addEventListener("click", () => {
      const value = dot.dataset.accent === getSetting("accent") ? "" : dot.dataset.accent;
      setSetting("accent", value);
      applyAppearanceSettings();
      syncControls();
      const color = value || "#0ae448";
      gsap.fromTo(dot, { scale: 0.7 }, { scale: 1, duration: 0.45, ease: "elastic.out(1, 0.5)" });
      applyAccentToGsap(color);
    });
  });

  // theme
  panel.querySelectorAll(".theme-opt").forEach((opt) => {
    opt.addEventListener("click", () => {
      setSetting("theme", opt.dataset.themeChoice);
      applyTheme();
      syncControls();
      gsap.fromTo(opt, { scale: 0.96 }, { scale: 1, duration: 0.4, ease: "elastic.out(1, 0.5)" });
      // The hero's tile field bakes its colours in at build time (each tile
      // holds finished rgba strings so the frame loop allocates nothing), so it
      // has to be rebuilt to pick up the other palette — the same call the
      // motion switch above uses.
      initHeroTiles();
      // Layout-dependent measurements shift slightly with the palette (scrollbar
      // colour, borders), and the ScrollTrigger positions were measured under
      // the old colours.
      if (window.ScrollTrigger) ScrollTrigger.refresh();
    });
  });

  const zoomSlider = panel.querySelector("#setting-zoom");
  if (zoomSlider) {
    zoomSlider.addEventListener("input", () => {
      setSetting("zoom", zoomSlider.value);
      applyAppearanceSettings();
    });
    zoomSlider.addEventListener("change", () => {
      // Layout-dependent measurements shift with the root font size.
      if (window.ScrollTrigger) ScrollTrigger.refresh();
      revealVisibleNow();
    });
  }

  const chatSlider = panel.querySelector("#setting-chat-width");
  if (chatSlider) {
    const applyChat = () => {
      const w = clampChatWidth(chatSlider.value);
      setSetting("chatWidth", String(w));
      document.documentElement.style.setProperty("--chat-w", w + "%");
      const label = document.getElementById("chat-width-label");
      if (label) label.textContent = w + "%";
      // The message list reflows with the card, so anything anchored to the
      // bottom (or measured by ScrollTrigger) has to be re-read.
      const area = document.getElementById("chat-msg-area");
      if (area) area.scrollTop = area.scrollHeight;
      if (window.ScrollTrigger) ScrollTrigger.refresh();
    };
    chatSlider.addEventListener("input", applyChat);
    chatSlider.addEventListener("change", applyChat);
    chatSlider.value = clampChatWidth(getSetting("chatWidth"));
  }

  const pillStyleSel = panel.querySelector("#setting-pill-style");
  if (pillStyleSel) {
    pillStyleSel.addEventListener("change", () => {
      setSetting("pillStyle", pillStyleSel.value);
      // The entrance is a one-shot per page load, so a change cannot replay
      // itself. Say that rather than leaving the user waiting for something.
      toast("已切换，刷新后生效");
    });
  }

  document.getElementById("settings-reset").addEventListener("click", () => {
    Object.keys(SETTINGS_DEFAULTS).forEach((k) => localStorage.removeItem("fh-set-" + k));
    applyAppearanceSettings();
    build();
    if (getSetting("pointer") === "on") initPointerEffect();
    syncControls();
    toast("设置已恢复默认");
  });

  syncControls();
}

/* The accent colour is also used inside GSAP tweens (particles, bars). */
function applyAccentToGsap(color) {
  window.__fhAccent = color;
}

function accent() {
  // Read the live setting first so a reset cannot leave a stale colour behind.
  return getSetting("accent") || window.__fhAccent || "#0ae448";
}

/* ================= v11: pointer-following hero background ================= */

let pointerCtx = null;

function initPointerEffect() {
  const hero = document.querySelector(".hero");
  if (!hero || getSetting("pointer") !== "on") return;
  if (pointerCtx) return;

  const bg = hero.querySelector(".hero-bg");
  if (!bg) return;

  // Companion shapes that trail the cursor at different rates, echoing the
  // geometric cursor-motion style of the reference site.
  const layer = document.createElement("div");
  layer.className = "pointer-layer";
  layer.setAttribute("aria-hidden", "true");
  layer.innerHTML =
    '<div class="ptr ptr-ring"></div>' +
    '<div class="ptr ptr-dot"></div>' +
    '<div class="ptr ptr-square"></div>' +
    '<div class="ptr ptr-cross-h"></div>' +
    '<div class="ptr ptr-cross-v"></div>';
  bg.appendChild(layer);

  const ring = layer.querySelector(".ptr-ring");
  const dot = layer.querySelector(".ptr-dot");
  const square = layer.querySelector(".ptr-square");
  const crossH = layer.querySelector(".ptr-cross-h");
  const crossV = layer.querySelector(".ptr-cross-v");

  // quickTo keeps a single reusable tween per property instead of spawning one
  // per mousemove — the documented pattern for high-frequency updates.
  const ringX = gsap.quickTo(ring, "x", { duration: 0.9, ease: "power3.out" });
  const ringY = gsap.quickTo(ring, "y", { duration: 0.9, ease: "power3.out" });
  const dotX = gsap.quickTo(dot, "x", { duration: 0.25, ease: "power3.out" });
  const dotY = gsap.quickTo(dot, "y", { duration: 0.25, ease: "power3.out" });
  const sqX = gsap.quickTo(square, "x", { duration: 1.4, ease: "power3.out" });
  const sqY = gsap.quickTo(square, "y", { duration: 1.4, ease: "power3.out" });
  const chX = gsap.quickTo(crossH, "x", { duration: 0.6, ease: "power2.out" });
  const cvY = gsap.quickTo(crossV, "y", { duration: 0.6, ease: "power2.out" });

  // The headline leans away from the cursor for a shallow parallax against the
  // tile field behind it. The field itself tracks the pointer in initHeroTiles.
  const titleX = gsap.quickTo(".hero-title", "x", { duration: 1.2, ease: "power2.out" });

  const onMove = (e) => {
    const r = hero.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const nx = (x / r.width - 0.5) * 2;   // -1 … 1

    ringX(x); ringY(y);
    dotX(x); dotY(y);
    sqX(x); sqY(y);
    chX(x); cvY(y);

    titleX(nx * -4);

    gsap.to(square, {
      rotation: 45 + nx * 90, duration: 0.8, ease: "power2.out", overwrite: "auto",
    });
    gsap.to(layer, { "--tilt": nx, duration: 0.6, overwrite: "auto" });
  };

  const onEnter = () => gsap.to(layer, { autoAlpha: 1, duration: 0.5 });
  const onLeave = () => gsap.to(layer, { autoAlpha: 0, duration: 0.5 });

  gsap.set(layer, { autoAlpha: 0 });
  hero.addEventListener("pointermove", onMove);
  hero.addEventListener("pointerenter", onEnter);
  hero.addEventListener("pointerleave", onLeave);

  // click ripple
  const onClick = (e) => {
    const r = hero.getBoundingClientRect();
    const ripple = document.createElement("div");
    ripple.className = "ptr-ripple";
    ripple.style.left = e.clientX - r.left + "px";
    ripple.style.top = e.clientY - r.top + "px";
    bg.appendChild(ripple);
    gsap.fromTo(ripple, { scale: 0, autoAlpha: 0.85 }, {
      scale: 1, autoAlpha: 0, duration: 0.9, ease: "power2.out",
      onComplete: () => ripple.remove(),
    });
  };
  hero.addEventListener("click", onClick);

  pointerCtx = { layer, hero, onMove, onEnter, onLeave, onClick };
}

function destroyPointerEffect() {
  if (!pointerCtx) return;
  const { layer, hero, onMove, onEnter, onLeave, onClick } = pointerCtx;
  hero.removeEventListener("pointermove", onMove);
  hero.removeEventListener("pointerenter", onEnter);
  hero.removeEventListener("pointerleave", onLeave);
  hero.removeEventListener("click", onClick);
  gsap.to(layer, { autoAlpha: 0, duration: 0.3, onComplete: () => layer.remove() });
  pointerCtx = null;
}

/* ================= v15: extruded 3D tile field in the hero =================

   The hero background is a matrix of 3D tiles that rise toward the pointer.
   Everything is drawn on one canvas through a pinhole camera, so the depth is
   real projection rather than a faked skew:

     world  x → right,  y → away from the camera,  z → up
     the camera floats CAM_H above the plane, pitched down by CAM_PITCH

   A point's screen position is its offset from the camera axis divided by its
   depth, and that division is what produces the vanishing point. World units
   are scaled so one unit is about one pixel on the nearest row, which lets the
   tile and gap constants below read directly as pixels.

   The camera positions the tiles only. The lift is deliberately NOT a world
   height: seen from this far above the plane, the vertical axis is compressed
   to almost nothing — one world unit of height is worth about 0.1 px on
   screen — so a fixed world height would raise the near rows by nothing and
   the far rows by a little. Holding the rise in screen pixels instead makes
   the whole field pop by the same amount whatever its depth.

   The faces are drawn as frosted panels rather than solid fills, after the
   Rhine Lab terminal (github.com/LBEILC/RhineLabUI): a barely-there translucent
   face, a lit band across its upper edge, and one hairline along the top — the
   separation between tiles is the ground showing through the gap, not a drawn
   border. A tile that rises stops being frosted: its faces take the accent and
   its edge brightens, the way the reference's glass clears when a file is read. */

const CAM_PITCH = Math.PI / 3;    // 60° down
const COS_P = Math.cos(CAM_PITCH);
const SIN_P = Math.sin(CAM_PITCH);
const CAM_H = 3000;               // camera height above the tile plane
const FOCAL = CAM_H * SIN_P;      // distance that makes the scale 1 at y = 0
const TILE_PITCH = 68;            // world units across, from one tile to the next
const TILE_GAP = 6;               // world units of empty space between tiles
const NEAR_MARGIN = 60;           // px the nearest row overshoots the bottom
const MAX_ROWS = 64;              // loop guard, well above any real row count
const LIFT_PX = 42;               // px a tile rises under the cursor
const IDLE_PX = 6;                // px of the resting undulation
const FLARE = 0.06;               // a fully raised tile reads this much wider
const LIFT_REACH = 165;           // px of cursor reach on the nearest row
const LIFT_EASE = 0.16;           // per-frame approach to the target height

/* A tile's depth is its width times SIN_P. Looking down at a plane from this
   pitch, one world unit of depth lands as 1/SIN_P screen pixels — the depth
   direction is stretched, not squashed — so the tile has to be that much
   shallower in world units to come out square on screen. Measured back off the
   canvas, this puts a 62-wide tile at 62 px tall on the near row. */
const TILE_W = TILE_PITCH - TILE_GAP;
const TILE_D = TILE_W * SIN_P;
const ROW_PITCH = TILE_D + TILE_GAP;

/* Faces, as [r, g, b, alpha] over the page ground. The values are alphas,
   because a frosted panel is a thin wash of the ground rather than a colour of
   its own. Each face gets stronger toward the viewer so the far rows sink into
   the background; the side face stays far dimmer than the top, which is what
   gives a raised tile its shadowed edge.

   Two palettes, because the wash has to go the other way on a light page. The
   dark theme draws pale tiles (#e0e3dc) as a thin light wash on near-black;
   the same colour on the light theme's #f6f7f6 ground is light-on-light and the
   field all but disappears. There the tiles are dark instead — the reference's
   off-white becomes a graphite — and the alphas roughly double, because a dark
   wash on white needs more of itself to register than a light wash on black
   does. Only the hue and strength change: every geometric and motion constant
   below is shared, so the field behaves identically in both themes. */
const TILE_INK = {
  dark: { c: [224, 227, 220], k: 1 },
  light: { c: [58, 66, 60], k: 1.9 },
};

function tilePalette(theme) {
  const p = TILE_INK[theme] || TILE_INK.dark;
  const c = p.c, k = p.k;
  const a = (v) => [c[0], c[1], c[2], +(v * k).toFixed(4)];
  return {
    faceFar: a(0.022), faceNear: a(0.055),
    sheenFar: a(0.045), sheenNear: a(0.075),
    coreFar: a(0.075), coreNear: a(0.13),
    sideFar: a(0.012), sideNear: a(0.028),
    edgeFar: a(0.18), edgeNear: a(0.42),
  };
}

/* The lit band is two steps rather than a real gradient: a fresh gradient object
   per tile per frame costs far more than the second fill does, and at this size
   the eye reads the two steps as one soft falloff. */
const SHEEN_BAND = 0.32;      // fraction of a tile the wide band covers
const CORE_BAND = 0.13;       // ...and the narrow one
const EDGE_PX = 1.5;          // thickness of the hairline, in device pixels
const ACCENT_TOP = 0.8;       // alpha a fully raised top face settles at
const ACCENT_SIDE = 0.3;      // ...and its side face, which stays in shadow
const TAU = Math.PI * 2;

let heroTiles = null;

function initHeroTiles() {
  destroyHeroTiles();
  const canvas = document.getElementById("hero-tiles");
  const hero = canvas && canvas.closest(".hero");
  if (!canvas || !hero) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;   // no canvas support: the hero keeps its gradient

  // Motion off, or the OS asking for less of it, means one still frame instead
  // of a running loop. The field is worth drawing either way — it is the hero's
  // background, not decoration bolted onto it.
  const animated = motionPref() &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let W = 1, H = 1, CX = 0, CY = 0, DPR = 1, tiles = [];
  let pointerX = -1e5, pointerY = -1e5, pointerIn = false;
  let clock = 0, last = 0, raf = 0, inView = true, alive = true;
  let accentSrc = "", accentRGB = [10, 228, 68];

  // ---- projection ----
  // project() writes into px/py/ps rather than returning an object: the field
  // runs to ~500 tiles and a fresh object per corner would hand the collector
  // several thousand allocations a second for nothing.
  let px = 0, py = 0, ps = 1;
  function project(wx, wy, z) {
    const s = FOCAL / (wy * COS_P + (CAM_H - z) * SIN_P);
    px = CX + wx * s;
    py = CY - (wy * SIN_P + (z - CAM_H) * COS_P) * s;
    ps = s;
  }

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  function mix(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
      +(a[3] + (b[3] - a[3]) * t).toFixed(3),
    ];
  }

  function css(c) {
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + c[3] + ")";
  }

  // Builds a raised face's colour straight from the base quad: the resting path
  // is precomputed at build time, so only the few tiles the cursor is lifting
  // pay for this, and an intermediate array each frame would be pure garbage.
  function liftColor(base, k, rate, alpha) {
    const m = k * rate;
    return "rgba(" +
      Math.round(base[0] + (accentRGB[0] - base[0]) * m) + "," +
      Math.round(base[1] + (accentRGB[1] - base[1]) * m) + "," +
      Math.round(base[2] + (accentRGB[2] - base[2]) * m) + "," +
      (base[3] + (alpha - base[3]) * m).toFixed(3) + ")";
  }

  // One quad, four corners, filled with the current fillStyle.
  function quad(x1, y1, x2, y2, x3, y3, x4, y4) {
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.lineTo(x3, y3); ctx.lineTo(x4, y4);
    ctx.closePath();
    ctx.fill();
  }

  function parseColor(css) {
    const c = String(css).trim();
    let out = null;
    if (c.charAt(0) === "#") {
      const hex = c.slice(1);
      const step = hex.length === 3 ? 1 : hex.length >= 6 ? 2 : 0;
      if (step) {
        out = [0, 1, 2].map((i) => {
          const part = hex.substr(i * step, step);
          return parseInt(step === 1 ? part + part : part, 16);
        });
      }
    } else {
      const m = c.match(/(\d+)\D+(\d+)\D+(\d+)/);
      if (m) out = [+m[1], +m[2], +m[3]];
    }
    return out && out.every((v) => v >= 0 && v <= 255) ? out : [10, 228, 68];
  }

  // ---- geometry ----
  function measure() {
    const r = hero.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    // 1.5 rather than the full ratio: the tiles are large flat fills, so the
    // extra samples buy almost nothing and cost fill rate on a big display.
    DPR = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    CX = W / 2;
    // Put the nearest row just below the hero's bottom edge; the rows walked
    // out from there are what fill the section.
    CY = H + NEAR_MARGIN - CAM_H * COS_P;
    buildTiles();
  }

  function buildTiles() {
    // Read the palette once per rebuild rather than per tile: the theme cannot
    // change mid-build, and applyTheme() rebuilds the field when it does.
    const P = tilePalette(document.documentElement.getAttribute("data-theme"));
    // Walk rows away from the camera until one has left the top of the hero.
    // Rows land in nearest-first order so draw() can walk the array backwards
    // and paint far rows before near ones are able to cover them.
    let rows = 0, yFar = 0;
    for (let j = 0; j < MAX_ROWS; j++) {
      const wy = j * ROW_PITCH;
      project(0, wy + ROW_PITCH, 0);
      if (py < -ROW_PITCH) break;
      rows = j + 1;
      yFar = wy + ROW_PITCH;
    }

    // The farthest row is the one that decides how wide the plane has to be.
    // The projection narrows with depth, so covering the hero's top corners
    // takes more world width out there than the near edge needs; the width is
    // measured once from that row and used for all of them, which keeps the
    // columns aligned and costs only the extra tiles the near rows do not need.
    const scaleFar = FOCAL / (yFar * COS_P + CAM_H * SIN_P);
    const half = Math.ceil(W / 2 / scaleFar / TILE_PITCH) * TILE_PITCH;
    const cols = (half / TILE_PITCH) * 2 + 1;

    tiles = [];
    for (let j = 0; j < rows; j++) {
      const wy = j * ROW_PITCH;
      // Row shade, normalised across the visible depth of the plane.
      const near = clamp01((FOCAL / (wy * COS_P + CAM_H * SIN_P) - scaleFar) / (1 - scaleFar));
      const topBase = mix(P.faceFar, P.faceNear, near);
      const sideBase = mix(P.sideFar, P.sideNear, near);
      const sheenBase = mix(P.sheenFar, P.sheenNear, near);
      const coreBase = mix(P.coreFar, P.coreNear, near);
      const edgeBase = mix(P.edgeFar, P.edgeNear, near);
      for (let i = 0; i < cols; i++) {
        const wx = -half + i * TILE_PITCH;
        // A tile's ground footprint is fixed for the life of the layout, so all
        // four corners are projected once here. Nothing in draw() needs the
        // camera again — only the lift, which is a screen-space offset, and the
        // scale the cursor's reach is measured in (ps, left over from the last
        // corner, whose value stands in for the whole tile).
        project(wx, wy, 0);            const a0 = px, e0 = py;   // near edge
        project(wx + TILE_W, wy, 0);   const a1 = px, e1 = py;
        project(wx + TILE_W, wy + TILE_D, 0); const a2 = px, e2 = py;  // far edge
        project(wx, wy + TILE_D, 0);   const a3 = px, e3 = py;
        tiles.push({
          a0: a0, e0: e0, a1: a1, e1: e1, a2: a2, e2: e2, a3: a3, e3: e3,
          cx: (a0 + a1 + a2 + a3) / 4, cy: (e0 + e1 + e2 + e3) / 4,
          scale: ps, lift: 0,
          topBase: topBase,
          sideBase: sideBase,
          sheenBase: sheenBase,
          coreBase: coreBase,
          edgeBase: edgeBase,
          // The resting appearance never changes, so its strings are built once
          // here and the per-frame path is a plain assignment.
          topFlat: css(topBase),
          sideFlat: css(sideBase),
          sheenFlat: css(sheenBase),
          coreFlat: css(coreBase),
          edgeFlat: css(edgeBase),
        });
      }
    }
  }

  // ---- drawing ----
  function draw(dt) {
    // The accent is changeable from the settings panel at any time; re-parse it
    // only when it actually moves.
    const src = (typeof window.__fhAccent === "string" && window.__fhAccent) || "#0ae448";
    if (src !== accentSrc) {
      accentSrc = src;
      accentRGB = parseColor(src);
    }

    ctx.clearRect(0, 0, W, H);
    const ease = 1 - Math.pow(1 - LIFT_EASE, dt * 60);

    for (let i = tiles.length - 1; i >= 0; i--) {
      const t = tiles[i];

      // The resting breath. Two superimposed periods — 8s and 13s, as in the
      // reference — so the field never settles into a loop the eye can catch,
      // plus a small phase offset per tile so it travels rather than pulsing as
      // one sheet.
      const phase = t.cx * 0.004 + t.cy * 0.009;
      const breath = Math.sin(clock * (TAU / 8) + phase) * 0.6 +
                     Math.sin(clock * (TAU / 13) + phase * 1.6) * 0.4;
      const idle = IDLE_PX * (0.5 + 0.5 * breath);

      // Cursor lift, eased so the field keeps settling after the pointer stops.
      let target = 0;
      if (pointerIn) {
        const dx = t.cx - pointerX, dy = t.cy - pointerY;
        const reach = LIFT_REACH * t.scale;
        const q = (dx * dx + dy * dy) / (reach * reach);
        if (q < 9) target = Math.exp(-q * 2.4);
      }
      t.lift += (target - t.lift) * ease;

      const rise = idle + t.lift * LIFT_PX;
      const k = clamp01(rise / LIFT_PX);
      // The hairline is measured in device pixels so it stays a hairline on a
      // retina display instead of doubling into a border.
      const hpx = Math.max(1, t.e0 - t.e3);
      const band = SHEEN_BAND;
      const core = CORE_BAND;
      const line = Math.min(core, EDGE_PX / (DPR * hpx));

      if (rise > 1.2) {
        // A raised tile stops being frosted: its faces take the accent and its
        // edge brightens, the reference's glass clearing as it is read. The tile
        // also widens very slightly, standing in for the extra perspective a
        // real block picks up on its way toward the camera; that flare plus the
        // shadowed side face, and not any drawn outline, is what makes it read
        // as a solid rather than a merely lit panel.
        const g = 1 + FLARE * k;
        const tx0 = t.cx + (t.a0 - t.cx) * g, ty0 = t.cy + (t.e0 - t.cy) * g - rise;
        const tx1 = t.cx + (t.a1 - t.cx) * g, ty1 = t.cy + (t.e1 - t.cy) * g - rise;
        const tx2 = t.cx + (t.a2 - t.cx) * g, ty2 = t.cy + (t.e2 - t.cy) * g - rise;
        const tx3 = t.cx + (t.a3 - t.cx) * g, ty3 = t.cy + (t.e3 - t.cy) * g - rise;

        // Side face, from the tile's base edge up to its raised top edge.
        ctx.fillStyle = liftColor(t.sideBase, k, 0.5, ACCENT_SIDE);
        quad(t.a0, t.e0, t.a1, t.e1, tx1, ty1, tx0, ty0);

        // Top face, held uniform so a raised block reads as one solid piece,
        // then a bright rim along its far edge.
        ctx.fillStyle = liftColor(t.topBase, k, 0.8, ACCENT_TOP);
        quad(tx0, ty0, tx1, ty1, tx2, ty2, tx3, ty3);
        ctx.fillStyle = liftColor(t.edgeBase, k, 0.8, 1);
        quad(
          tx3 + (tx0 - tx3) * line, ty3 + (ty0 - ty3) * line,
          tx2 + (tx1 - tx2) * line, ty2 + (ty1 - ty2) * line,
          tx2, ty2, tx3, ty3
        );
      } else {
        // Resting: a barely-there translucent panel, a lit band across its upper
        // edge in two steps, and one hairline on top. The dark line the eye reads
        // as a border is the ground showing through the gap between tiles — no
        // outline is drawn.
        const flat = k < 0.02;
        ctx.fillStyle = flat ? t.topFlat : liftColor(t.topBase, k, 0.8, ACCENT_TOP);
        quad(t.a0, t.e0, t.a1, t.e1, t.a2, t.e2, t.a3, t.e3);
        ctx.fillStyle = flat ? t.sheenFlat : liftColor(t.sheenBase, k, 0.8, 0.95);
        quad(
          t.a3 + (t.a0 - t.a3) * band, t.e3 + (t.e0 - t.e3) * band,
          t.a2 + (t.a1 - t.a2) * band, t.e2 + (t.e1 - t.e2) * band,
          t.a2, t.e2, t.a3, t.e3
        );
        ctx.fillStyle = flat ? t.coreFlat : liftColor(t.coreBase, k, 0.8, 0.95);
        quad(
          t.a3 + (t.a0 - t.a3) * core, t.e3 + (t.e0 - t.e3) * core,
          t.a2 + (t.a1 - t.a2) * core, t.e2 + (t.e1 - t.e2) * core,
          t.a2, t.e2, t.a3, t.e3
        );
        ctx.fillStyle = flat ? t.edgeFlat : liftColor(t.edgeBase, k, 0.8, 1);
        quad(
          t.a3 + (t.a0 - t.a3) * line, t.e3 + (t.e0 - t.e3) * line,
          t.a2 + (t.a1 - t.a2) * line, t.e2 + (t.e1 - t.e2) * line,
          t.a2, t.e2, t.a3, t.e3
        );
      }
    }
  }

  // ---- loop ----
  function tick(now) {
    if (!alive) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now;
    clock += dt;
    draw(dt);
    raf = requestAnimationFrame(tick);
  }

  function start() {
    if (!alive || raf) return;
    last = 0;
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  // Nothing to animate while the tab is hidden or the hero has scrolled away —
  // the same bargain the ambient GSAP tweens make.
  function sync() {
    if (animated && inView && !document.hidden) start();
    else stop();
  }

  // ---- input ----
  const onMove = (e) => {
    const r = canvas.getBoundingClientRect();
    pointerX = e.clientX - r.left;
    pointerY = e.clientY - r.top;
    pointerIn = true;
  };
  const onLeave = () => { pointerIn = false; };

  const ro = new ResizeObserver(() => {
    measure();
    if (!animated) draw(0.016);   // a still frame has to be rebuilt by hand
  });
  const io = new IntersectionObserver((entries) => {
    inView = entries[0].isIntersecting;
    sync();
  });

  measure();
  if (animated) {
    hero.addEventListener("pointermove", onMove, { passive: true });
    hero.addEventListener("pointerleave", onLeave);
    document.addEventListener("visibilitychange", sync);
    ro.observe(hero);
    io.observe(hero);
    gsap.fromTo(canvas, { autoAlpha: 0 }, { autoAlpha: 1, duration: 1, delay: 0.15, ease: "power2.out" });
    sync();
  } else {
    gsap.set(canvas, { autoAlpha: 1 });
    draw(0.016);
  }

  function destroy() {
    alive = false;
    stop();
    ro.disconnect();
    io.disconnect();
    document.removeEventListener("visibilitychange", sync);
    hero.removeEventListener("pointermove", onMove);
    hero.removeEventListener("pointerleave", onLeave);
    gsap.killTweensOf(canvas);
    gsap.set(canvas, { clearProps: "opacity,visibility" });
    heroTiles = null;
  }

  heroTiles = { destroy };
}

function destroyHeroTiles() {
  if (heroTiles) heroTiles.destroy();
}


/* ================= v11: animated search box ================= */

function initSearchBox() {
  const form = document.getElementById("header-search");
  const input = document.getElementById("header-search-input");
  if (!form || !input) return;
  const box = document.getElementById("search-suggest");
  let timer = null;
  let items = [];
  let activeIndex = -1;

  const hide = () => {
    gsap.to(box, {
      autoAlpha: 0, y: -8, duration: 0.18, ease: "power2.in",
      onComplete: () => { box.hidden = true; },
    });
    activeIndex = -1;
  };

  const render = (results, q) => {
    if (!results.length) {
      box.innerHTML = '';
      const empty = document.createElement("div");
      empty.className = "suggest-empty";
      empty.textContent = q ? `没有找到「${q}」` : "输入关键词开始搜索";
      box.appendChild(empty);
    } else {
      box.innerHTML = '';
      results.forEach((r, i) => {
        const item = document.createElement("div");
        item.className = "suggest-item";
        item.dataset.index = i;
        const icon = document.createElement("span");
        icon.textContent = r.icon;
        const label = document.createElement("span");
        // Highlight the matched substring without ever injecting HTML.
        const idx = r.label.toLowerCase().indexOf(q.toLowerCase());
        if (q && idx >= 0) {
          label.append(document.createTextNode(r.label.slice(0, idx)));
          const mark = document.createElement("mark");
          mark.textContent = r.label.slice(idx, idx + q.length);
          label.append(mark, document.createTextNode(r.label.slice(idx + q.length)));
        } else {
          label.textContent = r.label;
        }
        const type = document.createElement("span");
        type.className = "suggest-type";
        type.textContent = r.type;
        item.append(icon, label, type);
        item.addEventListener("click", () => { window.location.href = r.href; });
        box.appendChild(item);
      });
      items = [...box.querySelectorAll(".suggest-item")];
    }
    box.hidden = false;
    gsap.fromTo(box, { autoAlpha: 0, y: -8 }, { autoAlpha: 1, y: 0, duration: 0.25, ease: "power3.out" });
    gsap.from(box.querySelectorAll(".suggest-item, .suggest-empty"), {
      autoAlpha: 0, x: -6, duration: 0.25, stagger: 0.03, ease: "power2.out",
    });
  };

  const fetchSuggestions = async (q) => {
    try {
      const res = await fetch("/api/suggest?q=" + encodeURIComponent(q));
      const data = await res.json();
      return data.results || [];
    } catch { return []; }
  };

  input.addEventListener("input", () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < 1) { hide(); return; }
    timer = setTimeout(async () => {
      render(await fetchSuggestions(q), q);
    }, 140);
  });

  input.addEventListener("input", () => {
    // subtle press feedback while typing
    gsap.fromTo(form, { scale: 1 }, { scale: 1.015, duration: 0.12, yoyo: true, repeat: 1, ease: "power2.out" });
  });

  input.addEventListener("focus", () => {
    gsap.to(form, { borderColor: accent(), duration: 0.25 });
    gsap.fromTo(form.querySelector("button svg"), { rotation: 0 }, { rotation: 360, duration: 0.5, ease: "power3.out" });
  });

  input.addEventListener("blur", () => {
    setTimeout(hide, 160);
    gsap.to(form, {
      borderColor: getSetting("accent") || "#2a2e2b",
      duration: 0.25,
      onComplete: () => form.style.removeProperty("border-color"),
    });
  });

  input.addEventListener("keydown", (e) => {
    if (box.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      activeIndex = e.key === "ArrowDown"
        ? (activeIndex + 1) % items.length
        : (activeIndex - 1 + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle("active", i === activeIndex));
      gsap.fromTo(items[activeIndex], { x: -3 }, { x: 0, duration: 0.2 });
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      items[activeIndex].click();
    } else if (e.key === "Escape") {
      hide();
    }
  });
}

/* ================= v11: comment edit / delete ================= */

function initCommentActions() {
  const list = document.getElementById("comment-list");
  if (!list) return;

  list.addEventListener("click", async (e) => {
    const editBtn = e.target.closest(".comment-edit");
    const delBtn = e.target.closest(".comment-del");
    const node = e.target.closest(".comment");
    if (!node) return;
    const cid = node.dataset.commentId;

    if (delBtn) {
      const ok = await askConfirm("删除评论", "删除后无法恢复，确定要删除这条评论吗？");
      if (!ok) return;
      const res = await fetch(`/api/comment/${cid}/delete`, { method: "POST" });
      if (!res.ok) { toast("删除失败"); return; }
      gsap.to(node, {
        autoAlpha: 0, x: 30, height: 0, paddingTop: 0, paddingBottom: 0,
        duration: 0.35, ease: "power2.in", onComplete: () => node.remove(),
      });
      toast("评论已删除");
      return;
    }

    if (editBtn) {
      const textEl = node.querySelector(".comment-text");
      if (node.querySelector(".comment-edit-area")) return; // already editing
      const original = textEl.textContent;

      const area = document.createElement("div");
      area.className = "comment-edit-area";
      const ta = document.createElement("textarea");
      ta.rows = 3;
      ta.maxLength = 2000;
      ta.value = original;
      const btns = document.createElement("div");
      btns.className = "comment-edit-btns";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn btn-ghost btn-sm";
      cancel.textContent = "取消";
      const save = document.createElement("button");
      save.type = "button";
      save.className = "btn btn-green btn-sm";
      save.textContent = "保存";
      btns.append(cancel, save);
      area.append(ta, btns);

      textEl.hidden = true;
      textEl.after(area);
      ta.focus();
      gsap.from(area, { autoAlpha: 0, y: -8, duration: 0.3, ease: "power3.out" });

      cancel.addEventListener("click", () => {
        gsap.to(area, {
          autoAlpha: 0, y: -6, duration: 0.2,
          onComplete: () => { area.remove(); textEl.hidden = false; },
        });
      });

      save.addEventListener("click", async () => {
        const body = ta.value.trim();
        if (!body) { toast("评论不能为空"); return; }
        const res = await fetch(`/api/comment/${cid}/edit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        });
        if (!res.ok) { toast("保存失败"); return; }
        textEl.textContent = body;
        area.remove();
        textEl.hidden = false;
        if (!node.querySelector(".comment-edited")) {
          const tag = document.createElement("span");
          tag.className = "comment-edited";
          tag.textContent = "（已编辑）";
          node.querySelector(".comment-time").after(tag);
        }
        gsap.fromTo(textEl, { autoAlpha: 0.4 }, { autoAlpha: 1, duration: 0.4 });
        toast("评论已更新");
      });
    }
  });
}

/* ---- boot ---- */
function initPasswordToggle() {
  document.querySelectorAll(".pw-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.classList.toggle("on", show);
      btn.title = show ? "隐藏密码" : "显示密码";
      btn.setAttribute("aria-label", btn.title);
      gsap.fromTo(btn, { scale: 0.85 }, { scale: 1, duration: 0.35, ease: "back.out(2.4)" });
      input.focus();
    });
  });
}

/* ================= v12: follower / following modal ================= */

function initFollowModal() {
  const modal = document.getElementById("follow-modal");
  if (!modal) return;
  const body = document.getElementById("follow-body");
  const title = document.getElementById("follow-title");
  const username = document.body.dataset.profileUser;
  if (!username) return;

  const close = () => {
    gsap.to(modal.querySelector(".follow-panel"), {
      autoAlpha: 0, y: 24, scale: 0.97, duration: 0.22, ease: "power2.in",
    });
    gsap.to(modal.querySelector(".preview-backdrop"), {
      autoAlpha: 0, duration: 0.22,
      onComplete: () => { modal.hidden = true; },
    });
  };

  document.querySelectorAll("[data-follow-tab]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const tab = btn.dataset.followTab;
      title.textContent = tab === "followers" ? "粉丝" : "正在关注";
      body.innerHTML = '';
      const loading = document.createElement("div");
      loading.className = "follow-empty";
      loading.textContent = "加载中…";
      body.appendChild(loading);

      modal.hidden = false;
      gsap.fromTo(modal.querySelector(".preview-backdrop"), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25 });
      gsap.fromTo(modal.querySelector(".follow-panel"),
        { autoAlpha: 0, y: 30, scale: 0.96 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.4, ease: "power3.out" });

      try {
        const res = await fetch(`/api/profile/${encodeURIComponent(username)}/${tab}`);
        const data = await res.json();
        body.innerHTML = '';
        if (!data.users.length) {
          const empty = document.createElement("div");
          empty.className = "follow-empty";
          empty.textContent = tab === "followers" ? "还没有粉丝" : "还没有关注任何人";
          body.appendChild(empty);
          return;
        }
        const me = document.body.dataset.me || "";
        data.users.forEach((u) => {
          const row = document.createElement("div");
          row.className = "follow-user";

          const a = document.createElement("a");
          a.className = "follow-user-link";
          a.href = `/u/${u.username}`;
          if (u.avatar) {
            const img = document.createElement("img");
            img.className = "avatar-img";
            img.src = u.avatar;
            img.alt = "";
            a.appendChild(img);
          } else {
            const sp = document.createElement("span");
            sp.className = "avatar";
            sp.textContent = u.username.slice(0, 1).toUpperCase();
            a.appendChild(sp);
          }
          const name = document.createElement("span");
          name.className = "follow-user-name";
          name.textContent = u.username;
          a.appendChild(name);
          row.appendChild(a);

          // A follow control per row, unless it is the viewer themselves.
          if (u.username !== me) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "follow-btn-sm" + (u.following ? " on" : "");
            btn.dataset.username = u.username;
            btn.textContent = u.following ? "正在关注" : "关注";
            row.appendChild(btn);
          }
          body.appendChild(row);
        });
        gsap.from(body.querySelectorAll(".follow-user"), {
          autoAlpha: 0, x: -10, duration: 0.3, stagger: 0.035, ease: "power2.out",
        });
      } catch {
        body.innerHTML = '';
        const err = document.createElement("div");
        err.className = "follow-empty";
        err.textContent = "加载失败，请重试";
        body.appendChild(err);
      }
    });
  });

  modal.querySelectorAll("[data-follow-close]").forEach((b) => b.addEventListener("click", close));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) close();
  });
}

/* ================= v12: staged hero entrance ================= */

/* On the home page the headline, the intro paragraph and the call-to-action
   arrive in sequence rather than all at once, matching the announced timing:
   headline at ~1s, the supporting paragraph at ~1.5s. */
function heroStagedEntrance() {
  const title = document.querySelector(".hero-title");
  const sub = document.querySelector(".hero-sub");
  const cta = document.querySelector(".hero-cta");
  if (!title) return;

  // Choreography: headline first, supporting copy at 1s, buttons at 1.5s.
  // The splash overlays this page for roughly a second, so the clock starts
  // when the curtain begins to lift; without a splash it starts immediately.
  // Elements are hidden up front so nothing flashes before its cue.
  gsap.set([sub, cta].filter(Boolean), { autoAlpha: 0, y: 20 });

  const intro = document.getElementById("intro");
  const base = intro ? 0.85 : 0;   // seconds until the hero is unobscured

  gsap.timeline({ delay: base })
    .to(title, { autoAlpha: 1, duration: 0.2, ease: "power2.out" }, 0)
    .to(sub, { autoAlpha: 1, y: 0, duration: 0.85, ease: "power3.out" }, 1.0)
    .to(cta, { autoAlpha: 1, y: 0, duration: 0.8, ease: "power3.out" }, 1.5);
}

/* ================= v13: WeChat-style community chat ================= */

const EMOJIS = [
  "😀","😄","😁","😆","😅","🤣","😂","🙂","😉","😊",
  "😍","😘","😜","🤔","🤨","😐","😑","😶","🙄","😏",
  "😥","😮","😯","😪","😴","😌","😔","😷","🤒","🤕",
  "👍","👎","👏","🙏","🤝","💪","✌️","🤞","👌","🖐",
  "❤️","💔","💯","🔥","✨","⭐","🎉","🎁","🌈","☀️",
  "📁","📄","📦","🖼️","🎬","🎵","💾","🔗","📌","🔒",
];

let chatQuote = null;   // {id, username, body}

function initChat() {
  const shell = document.querySelector(".chat-shell");
  if (!shell) return;
  const area = document.getElementById("chat-msg-area");
  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send");
  const counter = document.getElementById("chat-counter");
  const emojiBtn = document.getElementById("chat-emoji-btn");
  const emojiPanel = document.getElementById("chat-emoji-panel");
  const quoteBar = document.getElementById("chat-quote-bar");
  const quoteText = document.getElementById("chat-quote-text");
  const countEl = document.getElementById("chat-count");

  let chatQuote = null;
  let lastDate = null;

  /* ---- rendering ---- */

  // Linkify plain text without injecting HTML: the body is assembled from text
  // nodes, and only the matched URLs become anchors.
  const URL_RE = /(https?:\/\/[^\s]+|www\.[^\s]+)/g;
  function renderBody(container, text) {
    URL_RE.lastIndex = 0;
    let last = 0;
    let m;
    let found = false;
    while ((m = URL_RE.exec(text)) !== null) {
      found = true;
      if (m.index > last) {
        container.appendChild(document.createTextNode(text.slice(last, m.index)));
      }
      const a = document.createElement("a");
      const raw = m[0];
      a.href = raw.indexOf("www.") === 0 ? "https://" + raw : raw;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = raw;
      container.appendChild(a);
      last = m.index + raw.length;
    }
    if (!found) {
      container.textContent = text;
    } else if (last < text.length) {
      container.appendChild(document.createTextNode(text.slice(last)));
    }
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  function shortTime(ts) {
    const d = new Date(ts * 1000);
    const now = new Date();
    const hhmm = pad(d.getHours()) + ":" + pad(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return hhmm;
    return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hhmm;
  }

  function dateLabel(ts) {
    const d = new Date(ts * 1000);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return "今天";
    const y = new Date(now.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return "昨天";
    return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate();
  }

  function buildMessage(msg, animate) {
    const wrap = document.createElement("div");
    wrap.className = "chat-msg" + (msg.mine ? " mine" : "");
    wrap.dataset.msgId = msg.id;

    const av = document.createElement("span");
    av.className = "chat-msg-avatar";
    if (msg.avatar) {
      const img = document.createElement("img");
      img.src = msg.avatar;
      img.alt = "";
      av.appendChild(img);
    } else {
      av.textContent = msg.username.slice(0, 1).toUpperCase();
    }

    const bodyWrap = document.createElement("div");
    bodyWrap.className = "chat-msg-body";

    const name = document.createElement("span");
    name.className = "chat-msg-name";
    name.textContent = msg.username;

    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";

    if (msg.quote) {
      const q = document.createElement("div");
      q.className = "chat-quote";
      const qa = document.createElement("span");
      qa.className = "chat-quote-author";
      qa.textContent = msg.quote.username;
      const qt = document.createElement("span");
      qt.className = "chat-quote-text";
      qt.textContent = msg.quote.body;
      q.append(qa, qt);
      const quoteId = msg.quote.id;
      q.addEventListener("click", () => {
        const target = document.querySelector('.chat-msg[data-msg-id="' + quoteId + '"]');
        if (!target) return;
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        gsap.fromTo(target, { backgroundColor: "rgba(10,228,72,.16)" },
          { backgroundColor: "transparent", duration: 1.1, ease: "power2.out" });
      });
      bubble.appendChild(q);
    }

    const text = document.createElement("span");
    text.className = "chat-text";
    renderBody(text, msg.body);
    bubble.appendChild(text);

    const time = document.createElement("span");
    time.className = "chat-msg-time";
    time.textContent = shortTime(msg.created_at);

    bodyWrap.append(name, bubble, time);

    const actions = document.createElement("div");
    actions.className = "chat-msg-actions";
    const reply = document.createElement("button");
    reply.type = "button";
    reply.className = "icon-btn chat-reply";
    reply.title = "引用";
    reply.textContent = "↩";
    reply.addEventListener("click", function () { setQuote(msg); });
    actions.appendChild(reply);

    if (msg.mine) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "icon-btn chat-del";
      del.title = "删除";
      del.textContent = "🗑";
      del.addEventListener("click", async function () {
        const ok = await askConfirm("删除消息", "删除后无法恢复，确定吗？");
        if (!ok) return;
        const res = await fetch("/api/comment/" + msg.id + "/delete", { method: "POST" });
        if (!res.ok) { toast("删除失败"); return; }
        gsap.to(wrap, {
          autoAlpha: 0, x: 24, duration: 0.3, ease: "power2.in",
          onComplete: function () { wrap.remove(); },
        });
        toast("消息已删除");
      });
      actions.appendChild(del);
    }

    wrap.append(av, bodyWrap, actions);
    if (animate) {
      gsap.from(wrap, { autoAlpha: 0, y: 12, duration: 0.35, ease: "power3.out" });
    }
    return wrap;
  }

  function appendWithDateSep(msg, animate) {
    const day = dateLabel(msg.created_at);
    if (day !== lastDate) {
      lastDate = day;
      const sep = document.createElement("div");
      sep.className = "chat-date-sep";
      sep.textContent = day;
      area.appendChild(sep);
    }
    area.appendChild(buildMessage(msg, animate));
  }

  function renderMessages(messages) {
    area.innerHTML = "";
    lastDate = null;
    if (!messages.length) {
      const empty = document.createElement("div");
      empty.className = "chat-empty";
      empty.textContent = "还没有消息，来说第一句吧";
      area.appendChild(empty);
      return;
    }
    messages.forEach(function (m) { appendWithDateSep(m, false); });
    gsap.from(area.querySelectorAll(".chat-msg"), {
      autoAlpha: 0, y: 10, duration: 0.3, stagger: 0.012, ease: "power2.out",
    });
    area.scrollTop = area.scrollHeight;
  }

  /* ---- quote ---- */

  function setQuote(msg) {
    chatQuote = msg;
    quoteText.textContent = msg.username + "：" + msg.body.slice(0, 60);
    quoteBar.hidden = false;
    gsap.fromTo(quoteBar, { autoAlpha: 0, height: 0 },
      { autoAlpha: 1, height: "auto", duration: 0.25 });
    input.focus();
  }

  function clearQuote() {
    chatQuote = null;
    quoteBar.hidden = true;
  }

  document.getElementById("chat-quote-cancel").addEventListener("click", clearQuote);

  /* ---- load history ---- */

  async function load() {
    try {
      const res = await fetch("/api/chat");
      const data = await res.json();
      if (countEl) {
        countEl.textContent = data.messages.length ? data.senders + " 人参与过" : "";
      }
      renderMessages(data.messages);
    } catch (e) {
      area.innerHTML = '<div class="chat-empty"><p>加载失败，请重试</p></div>';
    }
  }

  /* ---- composer ---- */

  function syncSend() {
    sendBtn.disabled = input.value.trim().length === 0;
    counter.textContent = input.value.length + "/2000";
  }

  input.addEventListener("input", function () {
    input.style.height = "auto";
    input.style.height = Math.min(140, input.scrollHeight) + "px";
    syncSend();
  });

  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  sendBtn.addEventListener("click", send);

  async function send() {
    const body = input.value.trim();
    if (!body) return;
    sendBtn.disabled = true;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: body, quote_id: chatQuote ? chatQuote.id : null }),
      });
      if (res.status === 401) { toast("请先登录后发言"); return; }
      if (!res.ok) {
        const err = await res.json().catch(function () { return {}; });
        toast(err.detail || "发送失败");
        return;
      }
      const msg = await res.json();
      const empty = area.querySelector(".chat-empty");
      if (empty) empty.remove();
      appendWithDateSep(msg, true);
      area.scrollTop = area.scrollHeight;
      input.value = "";
      input.style.height = "auto";
      clearQuote();
      syncSend();
    } catch (e) {
      toast("网络错误，请重试");
    } finally {
      sendBtn.disabled = input.value.trim().length === 0;
    }
  }

  /* ---- emoji ---- */

  EMOJIS.forEach(function (e) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chat-emoji";
    b.textContent = e;
    b.addEventListener("click", function () {
      const s0 = input.selectionStart;
      const s1 = input.selectionEnd;
      input.value = input.value.slice(0, s0) + e + input.value.slice(s1);
      input.selectionStart = input.selectionEnd = s0 + e.length;
      input.focus();
      syncSend();
      gsap.fromTo(b, { scale: 0.7 }, { scale: 1, duration: 0.3, ease: "back.out(2.5)" });
    });
    emojiPanel.appendChild(b);
  });

  emojiBtn.addEventListener("click", function () {
    emojiPanel.hidden = !emojiPanel.hidden;
    if (!emojiPanel.hidden) {
      gsap.fromTo(emojiPanel, { autoAlpha: 0, y: 8 },
        { autoAlpha: 1, y: 0, duration: 0.25, ease: "power3.out" });
    }
  });

  document.addEventListener("click", function (e) {
    if (!emojiPanel.hidden && !emojiPanel.contains(e.target) && e.target !== emojiBtn) {
      emojiPanel.hidden = true;
    }
  });

  load();
}

/* ================= v20: edit repo name / description ================= */

function initRepoEditor() {
  const btn = document.getElementById("repo-edit-btn");
  const editor = document.getElementById("repo-editor");
  if (!btn || !editor) return;
  const titleEl = document.getElementById("repo-title");
  const descEl = document.getElementById("repo-desc");
  const nameInput = document.getElementById("repo-name-input");
  const descInput = document.getElementById("repo-desc-input");
  const cancel = document.getElementById("repo-edit-cancel");
  const save = document.getElementById("repo-edit-save");
  const owner = document.body.dataset.repoOwner;
  const repoName = document.body.dataset.repoName;

  const open = () => {
    gsap.set(editor, { clearProps: "opacity,visibility,height,transform" });
    editor.hidden = false;
    btn.hidden = true;
    gsap.fromTo(editor, { autoAlpha: 0, height: 0, y: -6 },
      { autoAlpha: 1, height: "auto", y: 0, duration: 0.34, ease: "power3.out" });
    nameInput.focus();
    nameInput.select();
  };

  const close = () => {
    gsap.to(editor, {
      autoAlpha: 0, height: 0, y: -6, duration: 0.26, ease: "power2.in",
      onComplete: () => {
        editor.hidden = true;
        // GSAP leaves inline opacity/visibility/height behind; clear them so
        // the hidden attribute is what controls visibility again.
        gsap.set(editor, { clearProps: "opacity,visibility,height,transform" });
        btn.hidden = false;
      },
    });
  };

  btn.addEventListener("click", open);
  cancel.addEventListener("click", close);

  save.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const description = descInput.value.trim();
    if (!name) { toast("仓库名不能为空"); return; }
    save.disabled = true;
    try {
      const res = await fetch(`/r/${owner}/${repoName}/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name, description: description }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast(err.detail || "保存失败");
        return;
      }
      const data = await res.json();
      titleEl.textContent = data.name;
      descEl.textContent = data.description;
      descEl.hidden = !data.description;
      close();
      toast("已保存");
      // A rename changes the URL, so reload onto the new address.
      if (data.name !== repoName) {
        setTimeout(() => {
          window.location.href = `/r/${owner}/${data.name}?msg=` +
            encodeURIComponent("仓库已更新");
        }, 600);
      }
    } catch (e) {
      toast("网络错误，请重试");
    } finally {
      save.disabled = false;
    }
  });
}

/* ================= v20: bulk bar enter / exit ================= */

function initBulkBarAnimation() { /* handled inside initBulkSelect */ }

/* ================= v13: repo cover upload ================= */

/* The cover preview carries the same pointer-following light as the cards and
   the search field — the ring travels along its border and a soft bloom sits
   outside it, so the panel reads as interactive rather than as a plain image.
   attachFieldGlow is reused rather than reimplemented: the preview is one large
   element that owns its whole area, which is the case that helper was written
   for, unlike the cards which need their grid driving them. */
function initCoverFieldGlow() {
  document.querySelectorAll(".cover-preview").forEach((el) => {
    el.style.setProperty("--glow-radius", "160px");
    attachFieldGlow(el);
  });
}

/* Picking a file opens a crop dialog on the local picture; the form is only
   submitted once the owner confirms the square they want. The crop is sent
   with the upload and applied on the server, so what lands in storage is
   already the framed square — no guessing afterwards from a preview of a
   picture that was saved whole.

   The preview and the crop maths deliberately work in the same terms as the
   save: `zoom` is magnification and x/y is the window's centre as a
   percentage of the source, which is what server-side _crop_square reads. */
/* Repaint the cover panel from a server response, without a reload.
   Everything on the page that shows the cover is updated from the one payload:
   the preview behind the upload button, the "current cover" line's presence,
   which preset swatch is marked current, and the button's own label.

   The CSS is not reconstructed here — the server sends it (cover_css /
   cover_style), so the client never has to know how a cover key turns into a
   background. That is the same rule the rest of the cover code follows. */
function paintCover(data) {
  const art = document.querySelector("[data-cover-preview]");
  if (art) {
    // The server sends complete declarations either way — cover_css returns
    // `--cover-src` plus background properties for an upload, and a plain
    // `background:` shorthand for a preset. So the style attribute is replaced
    // wholesale; prefixing anything here would produce `background: background:`.
    art.setAttribute("style", data.css);
  }

  const pick = document.getElementById("cover-pick");
  if (pick) {
    pick.setAttribute("aria-label", data.is_upload ? "更换封面图片" : "上传封面图片");
    const text = pick.querySelector(".cover-preview-text");
    if (text) text.textContent = data.is_upload ? "更换封面" : "上传封面";
  }

  // The preset swatches: exactly one is current when a preset is in use.
  document.querySelectorAll(".cover-preset").forEach((btn) => {
    const on = btn.closest("form")?.querySelector("input[name=preset]")?.value === data.cover;
    btn.classList.toggle("current", on);
    btn.setAttribute("aria-checked", String(on));
  });

  // The reset row only exists while the cover is a custom upload. It is built
  // from a template because the server does not send markup back, and the row
  // is three elements.
  const card = pick?.closest(".side-card");
  const existing = card?.querySelector(".cover-current");
  if (!data.is_upload && existing) {
    existing.remove();
  } else if (data.is_upload && card && !existing) {
    const row = document.createElement("div");
    row.className = "cover-current";
    row.innerHTML =
      '<span class="cover-current-label">当前为自定义封面</span>' +
      '<form method="post" class="inline-form">' +
      '<button type="submit" class="btn btn-ghost btn-sm danger-btn">恢复默认</button></form>';
    const form = row.querySelector("form");
    form.action = location.pathname + "/cover/reset";
    card.appendChild(row);
  }
  initCoverReset();  // the row may be new, so its handler has to be armed too
}

/* Every cover-changing form on this page posts in the background and repaints
   in place, so none of them reloads. The markup still works without JavaScript:
   each form has a real action, and the server answers a plain post with the
   redirect it always did. */
function initCoverForms() {
  document.querySelectorAll(".cover-upload, .cover-preset-form").forEach((form) => {
    if (form.__coverAjax) return;
    form.__coverAjax = true;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      sendCoverForm(form);
    });
  });
  initCoverReset();
}

function initCoverReset() {
  document.querySelectorAll("form[action$='/cover/reset']").forEach((form) => {
    if (form.__coverAjax) return;
    form.__coverAjax = true;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      sendCoverForm(form, "恢复中…");
    });
  });
}

async function sendCoverForm(form, busy) {
  const btn = form.querySelector("button");
  const was = btn ? btn.textContent : "";
  if (btn && busy) { btn.textContent = busy; btn.disabled = true; }
  try {
    // Accept: application/json is what tells the server to answer with data
    // instead of a redirect. FormData carries the file and the crop untouched.
    const res = await fetch(form.action, {
      method: "POST",
      body: new FormData(form),
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) throw new Error("bad status");
    const data = await res.json();
    paintCover(data);
    toast(data.message || "封面已更新");
  } catch (err) {
    if (btn && busy) { btn.textContent = was; btn.disabled = false; }
    toast("封面更新失败，请重试");
  }
}

function initCoverPicker() {
  const fileInput = document.getElementById("cover-file");
  const pick = document.getElementById("cover-pick");
  if (!fileInput || !pick) return;

  pick.addEventListener("click", function () { fileInput.click(); });

  fileInput.addEventListener("change", function () {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    // Checked here for a fast, friendly failure; the server enforces it too.
    if (file.size > 10 * 1024 * 1024) {
      toast("封面图片不能超过 10 MB");
      fileInput.value = "";
      return;
    }
    // Only JPEG and PNG: other formats are rejected by the server too.
    if (!["image/jpeg", "image/png"].includes(file.type)) {
      toast("封面仅支持 JPG 或 PNG 格式");
      fileInput.value = "";
      return;
    }
    openCoverCrop(file, fileInput);
  });
}

/* The crop dialog: the chosen file shown in a square frame, with a zoom slider
   and drag-to-pan. Confirm submits the picker's form with the crop appended. */
function openCoverCrop(file, fileInput) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  // `zoom` here is the same number the server crops with. At 1 the window is
  // the largest square that fits inside the picture, and the preview draws the
  // picture at `cover` size scaled by zoom inside the square frame — so what is
  // seen in the frame is exactly what gets cut.
  const state = { zoom: 1, x: 50, y: 50 };

  img.onload = () => {
    const wrap = document.createElement("div");
    wrap.id = "cover-crop";
    wrap.className = "modal-page";
    wrap.innerHTML = [
      '<div class="preview-backdrop" data-crop-close></div>',
      '<div class="auth-card modal-card cover-dialog-card" role="dialog" aria-modal="true" aria-label="裁剪封面">',
      '  <h1 class="auth-title">裁剪封面</h1>',
      '  <p class="auth-sub">拖动图片调整位置，滑杆缩放。方框内的部分就是仓库封面。</p>',
      '  <div class="cover-dialog-body">',
      '    <div class="cover-crop-frame">',
      '      <img class="cover-crop-img" alt="">',
      '    </div>',
      '    <div class="cover-dialog-controls">',
      '      <div class="banner-row"><span>缩放</span>',
      '        <input type="range" data-crop="zoom" min="100" max="400" step="1">',
      '        <span class="banner-val" data-crop-val="zoom"></span>',
      '      </div>',
      '      <p class="cover-crop-hint">图片会以正方形保存，方框外的部分不会出现在封面上。</p>',
      '      <div class="cover-dialog-actions">',
      '        <button type="button" class="btn btn-ghost btn-sm" data-crop-close>取消</button>',
      '        <button type="button" class="btn btn-green btn-sm" id="cover-crop-save">使用这张</button>',
      '      </div>',
      '    </div>',
      '  </div>',
      '  <button type="button" class="dialog-x" data-crop-close aria-label="关闭">&#10005;</button>',
      '</div>',
    ].join("");
    document.body.appendChild(wrap);

    const frameEl = wrap.querySelector(".cover-crop-frame");
    const imgEl = wrap.querySelector(".cover-crop-img");
    imgEl.src = url;

    // The picture is drawn so the frame shows exactly the square that gets
    // stored. The frame IS the crop window, so the scale is "the largest square
    // that fits inside the picture, drawn to fill the frame":
    //
    //     base = frame size / min(srcW, srcH)
    //
    // At zoom 1 that makes the short side exactly fill the frame and lets the
    // long side overflow — the window is then min(w,h) square, which is exactly
    // what _crop_square() cuts.
    //
    // x and y mean what they mean on the server: the window's centre as an
    // absolute percentage of the SOURCE, then clamped so the window cannot
    // leave the picture. Reading them as "percent of the travel range" instead
    // made the two agree at 0/50/100 and disagree everywhere else — at zoom 1
    // on a 2:1 photo the server pins x=25% to the left edge while an unclamped
    // reading put the window 180px in.
    const windowBox = (fr) => {
      const z = (fr.width / Math.min(img.naturalWidth, img.naturalHeight)) * state.zoom;
      const w = fr.width / z;                       // window size in source px
      const h = fr.height / z;
      const cx = Math.min(Math.max(state.x / 100 * img.naturalWidth, w / 2),
                          img.naturalWidth - w / 2);
      const cy = Math.min(Math.max(state.y / 100 * img.naturalHeight, h / 2),
                          img.naturalHeight - h / 2);
      return { z, left: cx - w / 2, top: cy - h / 2, w, h };
    };

    const apply = () => {
      const fr = frameEl.getBoundingClientRect();
      const z = (fr.width / Math.min(img.naturalWidth, img.naturalHeight)) * state.zoom;
      const box = windowBox(fr);
      imgEl.style.width = (img.naturalWidth * z) + "px";
      imgEl.style.height = (img.naturalHeight * z) + "px";
      imgEl.style.left = (-box.left * z) + "px";
      imgEl.style.top = (-box.top * z) + "px";

      wrap.querySelectorAll("[data-crop-val]").forEach((o) => {
        o.textContent = Math.round(state[o.dataset.cropVal] * (o.dataset.cropVal === "zoom" ? 100 : 1)) + "%";
      });
      wrap.querySelectorAll("[data-crop]").forEach((i) => { i.value = state[i.dataset.crop] * 100; });
    };

    wrap.querySelectorAll("[data-crop]").forEach((input) => {
      input.addEventListener("input", () => {
        state[input.dataset.crop] = parseInt(input.value, 10) / 100;
        apply();
      });
    });

    // Drag to pan. Uses pointer capture so the drag survives the pointer
    // leaving the frame, which it does constantly at the edges.
    let dragging = null;
    frameEl.addEventListener("pointerdown", (e) => {
      dragging = { x: e.clientX, y: e.clientY, sx: state.x, sy: state.y };
      frameEl.setPointerCapture(e.pointerId);
      frameEl.classList.add("is-dragging");
    });
    frameEl.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const fr = frameEl.getBoundingClientRect();
      const z = (fr.width / Math.min(img.naturalWidth, img.naturalHeight)) * state.zoom;
      const box = windowBox(fr);
      // A drag of N pixels moves the window's centre by N/z source pixels, and
      // x/y are percentages of the source — so the delta is N/z/srcLen*100.
      // Derived from the same windowBox() apply() draws with, so the picture
      // tracks the pointer exactly and stops at the edge.
      const dx = (e.clientX - dragging.x) / z / img.naturalWidth * 100;
      const dy = (e.clientY - dragging.y) / z / img.naturalHeight * 100;
      // Dragging right moves the picture right, which shows more of its left.
      state.x = Math.min(100, Math.max(0, dragging.sx - dx));
      state.y = Math.min(100, Math.max(0, dragging.sy - dy));
      apply();
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = null;
      frameEl.classList.remove("is-dragging");
      try { frameEl.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    };
    frameEl.addEventListener("pointerup", endDrag);
    frameEl.addEventListener("pointercancel", endDrag);

    const close = () => {
      URL.revokeObjectURL(url);
      const card = wrap.querySelector(".modal-card");
      const back = wrap.querySelector(".preview-backdrop");
      if (card) gsap.to(card, { autoAlpha: 0, y: 20, scale: 0.97, duration: 0.22, ease: "power2.in" });
      if (back) gsap.to(back, { autoAlpha: 0, duration: 0.22, onComplete: () => wrap.remove() });
      else wrap.remove();
    };
    wrap.querySelectorAll("[data-crop-close]").forEach((el) => {
      el.addEventListener("click", () => { fileInput.value = ""; close(); });
    });
    const onEsc = (e) => { if (e.key === "Escape") { fileInput.value = ""; close(); document.removeEventListener("keydown", onEsc); } };
    document.addEventListener("keydown", onEsc);

    wrap.querySelector("#cover-crop-save").addEventListener("click", () => {
      // The crop rides along with the file in the same POST, so the server
      // cuts the square before storing — nothing is saved whole and re-framed.
      const hidden = document.createElement("input");
      hidden.type = "hidden";
      hidden.name = "crop";
      hidden.value = JSON.stringify({
        zoom: state.zoom,
        x: Math.round(state.x),
        y: Math.round(state.y),
      });
      fileInput.form.appendChild(hidden);
      close();
      // Goes through initCoverForms' submit handler, which posts in the
      // background and repaints in place — so the new cover appears without the
      // page reloading and losing scroll position, comments and the file list.
      fileInput.form.requestSubmit();
    });

    apply();
    gsap.fromTo(wrap.querySelector(".preview-backdrop"), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25 });
    gsap.fromTo(wrap.querySelector(".modal-card"),
      { autoAlpha: 0, y: 30, scale: 0.96 },
      { autoAlpha: 1, y: 0, scale: 1, duration: 0.42, ease: "power3.out" });
  };
  img.onerror = () => { toast("无法读取这张图片"); fileInput.value = ""; URL.revokeObjectURL(url); };
  img.src = url;
}

/* ================= v13: profile bio + banner ================= */

function initProfileCustomisation() {
  const root = document.getElementById("profile-custom");
  if (!root) return;

  /* ---- bio ---- */
  const bioText = document.getElementById("bio-text");
  const bioBtn = document.getElementById("bio-edit");
  const username = document.body.dataset.profileUser;

  bioBtn?.addEventListener("click", () => {
    if (document.querySelector(".bio-editor")) return;
    const wrap = document.createElement("div");
    wrap.className = "bio-editor";
    const ta = document.createElement("textarea");
    ta.rows = 3;
    ta.maxLength = 600;
    ta.placeholder = "写点自我介绍…";
    ta.value = bioText ? bioText.textContent : "";
    const actions = document.createElement("div");
    actions.className = "bio-editor-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-ghost btn-sm";
    cancel.textContent = "取消";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn btn-green btn-sm";
    save.textContent = "保存";
    actions.append(cancel, save);
    wrap.append(ta, actions);
    bioBtn.hidden = true;
    // Replace the paragraph in place: inserting alongside it would leave a
    // second copy behind once the editor closes.
    const anchorEl = bioText || bioBtn;
    anchorEl.before(wrap);
    if (bioText) bioText.hidden = true;
    ta.focus();
    gsap.from(wrap, { autoAlpha: 0, y: -8, duration: 0.3, ease: "power3.out" });

    cancel.addEventListener("click", () => {
      wrap.remove();
      if (bioText) bioText.hidden = !bioText.textContent;
      bioBtn.hidden = false;
    });

    save.addEventListener("click", async () => {
      const res = await fetch("/settings/bio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bio: ta.value }),
      });
      if (!res.ok) { toast("保存失败"); return; }
      const data = await res.json();
      let el = document.getElementById("bio-text");
      if (!el) {
        el = document.createElement("p");
        el.id = "bio-text";
        el.className = "profile-bio";
        wrap.after(el);
      }
      el.textContent = data.bio;
      el.hidden = !data.bio;
      el.hidden = !data.bio;
      wrap.remove();
      bioBtn.hidden = false;
      // Keep the button label in step with whether a bio now exists.
      bioBtn.textContent = data.bio ? "✏️ 编辑简介" : "✏️ 添加简介";
      toast("简介已保存");
    });
  });

  /* ---- banner (user-uploaded image) ---- */
  //
  // Applying the saved framing and offering the panel to change it are two
  // different jobs, and they are split here on purpose.
  //
  // The framing block below used to sit after a guard on #banner-panel and
  // #banner-edit — which only exist for the profile's owner — so it returned
  // early for every other visitor and the banner rendered with none of its
  // scale, opacity or position. The owner saw their own framing; everyone else
  // saw a flat cover-fit image. Framing is part of how the banner looks, not
  // part of editing it, so it now runs for whoever is looking.
  const bannerEl = document.getElementById("profile-banner-el");
  // Hoisted so the panel wiring further down can drive the same state. Kept as
  // one object rather than two copies: the panel edits it and the painter reads
  // it, and two copies would drift the moment one was saved.
  let bannerState = null;
  let applyBanner = null;
  if (bannerEl) {
    const inner = bannerEl.querySelector(".profile-banner-inner");
    bannerState = Object.assign({ scale: 100, x: 50, y: 50, opacity: 70, blur: 0 },
      window.__fhBanner || {});

    applyBanner = () => {
      inner.style.opacity = bannerState.opacity / 100;
      inner.style.backgroundPosition = bannerState.x + "% " + bannerState.y + "%";
      // Blur is applied after the scale so the softened edge is scaled too and
      // cannot reveal a hard rim at the frame; the layer is oversized in CSS to
      // leave the blur somewhere to fall off into.
      const b = bannerState.blur > 0 ? ` blur(${bannerState.blur}px)` : "";
      inner.style.transform = "scale(" + (bannerState.scale / 100) + ")";
      inner.style.filter = b.trim() || "none";
      // The picture has moved or been re-scaled, so what is underneath the text
      // has changed; the ink has to be re-judged against the new framing.
      adaptBannerInk(inner, bannerState);
    };
    applyBanner();
  }

  const panel = document.getElementById("banner-panel");
  const panelBtn = document.getElementById("banner-edit");
  if (!panel || !panelBtn) return;

  /* Toggle the customisation panel from the "自定义背景" button.
     The open and close are now a matched pair. Before, only the open was
     animated: closing just flipped `hidden`, so the panel vanished with no
     transition and left GSAP's inline `height: auto` behind. Reopening then
     started from that dirty state, which is why the first click animated and
     the second did not. Both directions now run a tween and clear the inline
     styles when they finish. */
  let bannerBusy = false;
  panelBtn.addEventListener("click", function () {
    if (bannerBusy) return;
    bannerBusy = true;
    const opening = panel.hidden;

    if (opening) {
      panel.hidden = false;
      panelBtn.classList.add("active");
      gsap.fromTo(panel,
        { autoAlpha: 0, height: 0 },
        { autoAlpha: 1, height: "auto", duration: 0.32, ease: "power3.out",
          onComplete: () => {
            gsap.set(panel, { clearProps: "height,opacity,visibility" });
            bannerBusy = false;
          } });
      panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else {
      panelBtn.classList.remove("active");
      gsap.to(panel, {
        autoAlpha: 0, height: 0, duration: 0.26, ease: "power3.in",
        onComplete: () => {
          panel.hidden = true;
          gsap.set(panel, { clearProps: "height,opacity,visibility" });
          bannerBusy = false;
        } });
    }
  });

  // The panel edits the same `state` the block above applied, so that block
  // exposes it rather than each half keeping its own copy — two copies would
  // drift the moment one was saved.
  if (bannerState) {
    // The readouts are not all percentages — blur is in px — so the suffix comes
    // from the control itself rather than being assumed.
    const syncControls = () => {
      panel.querySelectorAll("[data-banner]").forEach((el) => {
        el.value = bannerState[el.dataset.banner];
      });
      panel.querySelectorAll("[data-banner-val]").forEach((el) => {
        const key = el.dataset.bannerVal;
        el.textContent = key === "blur" ? bannerState[key] + "px" : bannerState[key] + "%";
      });
    };

    panel.querySelectorAll("[data-banner]").forEach((range) => {
      range.addEventListener("input", () => {
        bannerState[range.dataset.banner] = parseInt(range.value, 10);
        applyBanner();
        syncControls();
      });
    });

    document.getElementById("banner-save")?.addEventListener("click", async () => {
      const res = await fetch("/settings/banner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bannerState),
      });
      if (!res.ok) { toast("保存失败"); return; }
      window.__fhBanner = bannerState;
      toast("背景效果已保存");
      // Collapse the panel so the result is visible immediately.
      gsap.to(panel, {
        autoAlpha: 0, height: 0, duration: 0.36, ease: "power3.inOut",
        onComplete: function () {
          panel.hidden = true;
          panelBtn.classList.remove("active");
          gsap.set(panel, { clearProps: "opacity,visibility,height" });
        },
      });
      // No confirmation pulse on the background itself. The scale nudge that
      // used to run here moved the very thing the user had just finished
      // positioning, which is the opposite of what a "saved" cue should do —
      // the toast above is the feedback.
    });

    syncControls();
  }

  // upload triggers the file picker, then posts the file directly
  const fileInput = document.getElementById("banner-file");
  document.getElementById("banner-pick")?.addEventListener("click", () => fileInput.click());
  fileInput?.addEventListener("change", () => {
    if (fileInput.files.length) fileInput.form.submit();
  });
}

/* Choose the banner's text colour from how bright the picture actually is
   underneath it.

   The banner is an arbitrary upload, so no fixed text colour can suit it: on a
   light page a pale photo washes out dark text, and on a dark page a dark photo
   does the same to light text. Rather than veil the picture (which hides the
   very thing the owner chose to show), the ink flips to match — white over a
   dark picture, black over a light one. The accent colour is deliberately left
   alone: it is the user's chosen hue and reads on either.

   Two details that matter for the answer to be right:

   · Only the region the text occupies is sampled, not the whole banner. A
     bright sky on the right with a dark subject on the left would average out
     to "light" and put black text on the dark half.
   · The sample reads what is actually painted, which means reproducing the
     framing: the picture is `background-size: 170%` inside an oversized layer
     that is then scaled and positioned. Sampling the raw image instead would
     ignore the owner's crop entirely and can disagree with what is on screen. */
function adaptBannerInk(inner, state) {
  const wrap = inner.closest(".profile-banner") || inner.parentElement;
  const host = wrap.parentElement;              // the section the text sits in
  const info = host && host.querySelector(".profile-info");
  if (!info || !state) return;

  const url = (getComputedStyle(inner).backgroundImage.match(/url\(["']?([^"')]+)/) || [])[1];
  if (!url) return;

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  const paint = (img) => {
    const wrapRect = wrap.getBoundingClientRect();
    if (!wrapRect.width || !wrapRect.height) return;

    // Where the text is, as a fraction of the banner — measured rather than
    // assumed, because the avatar and stats move with the layout.
    const infoRect = info.getBoundingClientRect();
    const fx0 = clamp01((infoRect.left - wrapRect.left) / wrapRect.width);
    const fx1 = clamp01((infoRect.right - wrapRect.left) / wrapRect.width);
    const fy0 = clamp01((infoRect.top - wrapRect.top) / wrapRect.height);
    const fy1 = clamp01((infoRect.bottom - wrapRect.top) / wrapRect.height);

    const off = document.createElement("canvas");
    const N = 32;                                // sample grid, per axis
    off.width = N; off.height = N;
    const g = off.getContext("2d", { willReadFrequently: true });
    if (!g) return;

    // Reproduce the framing so the sample matches the screen. The layer is
    // 170% of the box and scaled by the owner's zoom; its overflow pans with
    // the position percentages. So the visible window is that rectangle,
    // expressed as a fraction of the image.
    const boxW = wrapRect.width, boxH = wrapRect.height;
    const layerW = boxW * 1.7 * (state.scale / 100);
    const layerH = boxH * 1.7 * (state.scale / 100);
    const overX = Math.max(0, layerW - boxW);
    const overY = Math.max(0, layerH - boxH);
    const winX = (overX * (state.x / 100)) / layerW;
    const winY = (overY * (state.y / 100)) / layerH;
    const winW = boxW / layerW;
    const winH = boxH / layerH;

    const sx = (winX + winW * fx0) * img.naturalWidth;
    const sy = (winY + winH * fy0) * img.naturalHeight;
    const sw = Math.max(1, winW * (fx1 - fx0) * img.naturalWidth);
    const sh = Math.max(1, winH * (fy1 - fy0) * img.naturalHeight);

    try {
      g.drawImage(img, sx, sy, sw, sh, 0, 0, N, N);
    } catch (e) {
      return;                                   // tainted or out of range
    }
    let data;
    try { data = g.getImageData(0, 0, N, N).data; } catch (e) { return; }

    // Perceived luminance (ITU-R BT.601), averaged over the text's region.
    let sum = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 8) continue;             // skip transparent pixels
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      n++;
    }
    if (!n) return;
    const mean = sum / n;                        // 0..255

    // The owner's opacity lets the page show through, so what is rendered is
    // lighter than the file on a light page (and darker on a dark one).
    // Composing the mean over the page colour keeps the judgement tied to what
    // is actually behind the text.
    //
    // The opacity is read from the rendered element, not from `state`: the
    // config is only present for the owner (the server emits window.__fhBanner
    // on their view alone), so a visitor would fall back to a default that does
    // not match what is on screen and could judge the same banner differently.
    // The DOM is the one source both views share.
    const pageRGB = (getComputedStyle(document.body).backgroundColor.match(/\d+/g) || []).slice(0, 3).map(Number);
    const rendered = parseFloat(getComputedStyle(inner).opacity);
    const a = Math.max(0, Math.min(1, Number.isFinite(rendered) ? rendered : 1));
    const composed = pageRGB.length === 3
      ? mean * a + (0.299 * pageRGB[0] + 0.587 * pageRGB[1] + 0.114 * pageRGB[2]) * (1 - a)
      : mean;

    // Over half luminance the picture is light, so the ink goes dark. The two
    // classes are set on the section, so the rule can reach the title, the
    // subtitle and the stats without each of them knowing about banners.
    const lightPicture = composed > 127.5;
    host.classList.toggle("banner-ink-dark", lightPicture);
    host.classList.toggle("banner-ink-light", !lightPicture);
  };

  // The image may not be decoded on first paint; judge once it is.
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => paint(img);
  img.onerror = () => { /* leave the theme's default ink in place */ };
  img.src = url;
}

/* ================= chat background =================
   The community page's backdrop. Same controls as the profile banner — scale,
   position, opacity, blur — but the two are deliberately separate features: the
   panel lives in the settings drawer (reachable from any page) while the banner
   panel sits on the profile, and each stores its own config on the user row, so
   they can be tuned independently.

   Two responsibilities, so two halves:
     - the settings drawer controls here, which write to the server;
     - applyChatBg() below, which paints whatever config the page was sent. */
function initChatBgControls() {
  const pick = document.getElementById("chat-bg-pick");
  const file = document.getElementById("chat-bg-file");
  if (!pick || !file) return;

  pick.addEventListener("click", () => file.click());
  file.addEventListener("change", () => {
    if (file.files.length) file.form.submit();
  });

  // The sliders only exist once an image has been uploaded — there is nothing
  // to scale or position without one — so they stay hidden until the server
  // renders a config.
  const hasImage = !!document.querySelector(".chat-bg-inner");
  const rows = ["chat-bg-rows", "chat-bg-rows2", "chat-bg-rows3", "chat-bg-rows4", "chat-bg-rows5"]
    .map((id) => document.getElementById(id));
  const actions = document.getElementById("chat-bg-actions");
  if (!hasImage) return;
  rows.forEach((r) => { if (r) r.hidden = false; });
  if (actions) actions.hidden = false;

  const state = Object.assign({ scale: 100, x: 50, y: 50, opacity: 30, blur: 0 },
    window.__fhChatBg || {});

  const apply = () => {
    applyChatBg(state);
    document.querySelectorAll("[data-chatbg-val]").forEach((el) => {
      const key = el.dataset.chatbgVal;
      el.textContent = key === "blur" ? state[key] + "px" : state[key] + "%";
    });
    document.querySelectorAll("[data-chatbg]").forEach((el) => {
      el.value = state[el.dataset.chatbg];
    });
  };

  document.querySelectorAll("[data-chatbg]").forEach((range) => {
    range.addEventListener("input", () => {
      state[range.dataset.chatbg] = parseInt(range.value, 10);
      apply();
    });
  });

  document.getElementById("chat-bg-save")?.addEventListener("click", async () => {
    const res = await fetch("/settings/chat-bg", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });
    if (!res.ok) { toast("保存失败"); return; }
    window.__fhChatBg = state;
    toast("聊天室背景已保存");
  });

  apply();
}

/* Paint a chat-background config onto the layer. Kept separate from the
   controls because the community page needs it too, where there is no drawer. */
function applyChatBg(state) {
  const inner = document.querySelector(".chat-bg-inner");
  if (!inner) return;
  inner.style.opacity = state.opacity / 100;
  inner.style.backgroundPosition = state.x + "% " + state.y + "%";
  inner.style.transform = "scale(" + (state.scale / 100) + ")";
  inner.style.filter = state.blur > 0 ? "blur(" + state.blur + "px)" : "none";
}

/* On the community page, read the config the server embedded and paint it. */
function initChatBgLayer() {
  const inner = document.querySelector(".chat-bg-inner");
  if (!inner) return;
  let cfg = {};
  try {
    cfg = JSON.parse(inner.dataset.chatbg || "{}");
  } catch (e) { cfg = {}; }
  const state = Object.assign({ scale: 100, x: 50, y: 50, opacity: 30, blur: 0 }, cfg);
  window.__fhChatBg = state;
  applyChatBg(state);
}

/* Cover backgrounds mirrored from the server so the picker can preview
   them client-side without a round trip. */
const COVER_CSS = {
  aurora: "linear-gradient(135deg, rgba(10,228,72,.13) 0%, transparent 45%), radial-gradient(ellipse 70% 90% at 20% 10%, rgba(10,228,72,.33), transparent 60%), radial-gradient(ellipse 60% 80% at 85% 85%, rgba(10,108,255,.27), transparent 65%), #101512",
  grid: "linear-gradient(rgba(59,157,255,.09) 1px, transparent 1px) 0 0 / 22px 22px, linear-gradient(90deg, rgba(59,157,255,.09) 1px, transparent 1px) 0 0 / 22px 22px, radial-gradient(ellipse 80% 70% at 50% 0%, rgba(59,157,255,.2), transparent 65%), #0a0f18",
  waves: "repeating-radial-gradient(circle at 15% 110%, transparent 0 28px, rgba(255,123,213,.08) 28px 30px), radial-gradient(ellipse 90% 80% at 15% 110%, rgba(255,123,213,.25), transparent 62%), #1a0813",
  sunset: "linear-gradient(160deg, rgba(255,176,32,.2) 0%, transparent 50%), radial-gradient(ellipse 80% 70% at 80% 15%, rgba(255,92,80,.2), transparent 60%), radial-gradient(ellipse 70% 80% at 10% 90%, rgba(255,176,32,.18), transparent 65%), #1a0f06",
  mint: "radial-gradient(circle at 30% 30%, rgba(45,212,191,.2), transparent 55%), radial-gradient(circle at 75% 70%, rgba(10,228,72,.15), transparent 55%), #061a18",
  violet: "linear-gradient(45deg, rgba(167,139,250,.12) 0%, transparent 55%), radial-gradient(ellipse 70% 90% at 70% 20%, rgba(167,139,250,.27), transparent 62%), #100823",
};

/* ================= v13: modal pages close on outside click ================= */

function initModalPages() {
  // ScrollSmoother puts a transform on an ancestor, which makes position:fixed
  // resolve against that ancestor instead of the viewport, pushing any overlay
  // off-centre. Re-parenting every fixed overlay to <body> restores true
  // viewport centring for all of them.
  ["#settings-panel", "#follow-modal", "#preview-modal", "#confirm-modal",
   "#meta-modal", ".modal-page"].forEach((sel) => {
    const el = document.querySelector(sel);
    if (el && el.closest("#smooth-wrapper")) document.body.appendChild(el);
  });

  // Dismissing always returns to the home page. Using document.referrer here
  // made login and register bounce between each other, because each was the
  // other's referrer — an endless redirect loop.
  //
  // Every .modal-page is wired, not just the first: the selector used to take
  // one and return, so on a page that renders several modal pages only the
  // first one's 取消 did anything. The rest fell through to the bare href="#",
  // which looked like "does nothing" rather than "returns home".
  document.querySelectorAll(".modal-page").forEach((page) => {
    page.querySelectorAll("[data-modal-close]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        gsap.to(page, {
          autoAlpha: 0, duration: 0.25, ease: "power2.in",
          onComplete: () => { window.location.href = "/"; },
        });
      });
    });
  });
}

/* ================= v13: follow list per-user button ================= */

function initFollowListButtons() {
  const body = document.getElementById("follow-body");
  if (!body) return;
  body.addEventListener("click", async (e) => {
    const btn = e.target.closest(".follow-btn-sm");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const username = btn.dataset.username;
    try {
      const res = await fetch(`/api/follow/${username}`, { method: "POST" });
      if (res.status === 401) { toast("请先登录"); return; }
      if (!res.ok) { toast("操作失败"); return; }
      const data = await res.json();
      btn.textContent = data.following ? "正在关注" : "关注";
      btn.classList.toggle("on", data.following);
      gsap.fromTo(btn, { scale: 0.9 }, { scale: 1, duration: 0.4, ease: "back.out(2.4)" });
    } catch {
      toast("网络错误");
    }
  });
}

/* ================= v18: header avatar behaviour ================= */

/* Signed in: the header avatar is a plain link to the profile. Signed out:
   clicking the placeholder opens the login modal in place, so the visitor is
   not thrown onto a separate page just to sign in. */
function initGuestAvatar() {
  const guest = document.getElementById("guest-avatar");
  if (!guest) return;
  guest.addEventListener("click", function () {
    openDialog("login");
  });
}

/* ================= discover tabs =================
   Switching a tab swaps the shelf only. It used to be a link to
   /search?tab=..., which reloaded the whole document: the users list below
   re-randomised, the scroll position reset, and the page flashed. Fetching the
   shelf and replacing the grid leaves everything else exactly as it was. */
function initDiscoverTabs() {
  const shelf = document.getElementById("discover-shelf");
  if (!shelf) return;
  let current = shelf.dataset.tab;

  const paint = (active) => {
    document.querySelectorAll("[data-discover-tab]").forEach((b) => {
      const on = b.dataset.discoverTab === active;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    });
  };

  document.querySelectorAll("[data-discover-tab]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const which = btn.dataset.discoverTab;
      if (which === current) return;

      // The pressed state moves immediately; the content follows when it
      // arrives, so the tab never feels unresponsive.
      paint(which);
      try {
        const res = await fetch("/api/discover/" + encodeURIComponent(which));
        if (!res.ok) throw new Error("bad status");
        const data = await res.json();
        current = data.tab;
        shelf.dataset.tab = data.tab;
        shelf.innerHTML = data.html;
        // The new cards have never been revealed, so give them the same
        // entrance the rest of the page uses rather than dropping them in flat.
        const cards = shelf.querySelectorAll(".repo-card");
        if (window.gsap && cards.length) {
          gsap.fromTo(cards, { autoAlpha: 0, y: 14 },
            { autoAlpha: 1, y: 0, duration: 0.4, stagger: 0.03, ease: "power3.out" });
        }
        initCardGlow();
        if (window.ScrollTrigger) ScrollTrigger.refresh();
      } catch (e) {
        // The content did not change, so the pressed state goes back with it.
        paint(current);
        toast("切换失败，请重试");
      }
    });
  });
}

/* ================= in-place sort tabs =================
   /repos and /people each carry a row of sort tabs above the grid. They used to
   be links, so every re-sort was a full navigation: the random people strip on
   /repos re-drew, the scroll went back to the top, and the page flashed. The
   tabs now fetch the sorted grid and swap only that.

   Both pages share this because the shape is identical — a #sort-tabs row with
   data-sort keys, and a #sort-panel holding the markup to replace. The endpoint
   is read off the tab row so one function serves both. */
function initSortTabs() {
  const tabs = document.getElementById("sort-tabs");
  const panel = document.getElementById("sort-panel");
  if (!tabs || !panel) return;
  const endpoint = tabs.dataset.sortEndpoint;
  if (!endpoint) return;

  let current = tabs.querySelector(".sort-tab.active")?.dataset.sort || "";
  let inflight = 0;

  const paint = (active) => {
    tabs.querySelectorAll(".sort-tab").forEach((b) => {
      const on = b.dataset.sort === active;
      b.classList.toggle("active", on);
      if (on) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    });
  };

  tabs.querySelectorAll(".sort-tab").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const sort = btn.dataset.sort;
      if (!sort || sort === current) return;

      // The pressed state moves on the click, not on the response, so the tab
      // never feels dead while the request is out. The token guards against an
      // earlier slow response landing after a later fast one and painting the
      // grid with the wrong sort.
      paint(sort);
      const token = ++inflight;
      btn.classList.add("is-loading");
      panel.classList.add("is-swapping");
      try {
        const res = await fetch(endpoint + "?sort=" + encodeURIComponent(sort));
        if (!res.ok) throw new Error("bad status");
        const data = await res.json();
        if (token !== inflight) return;
        current = data.sort;
        panel.innerHTML = data.html;
        const cards = panel.querySelectorAll(".repo-card, .person-card");
        if (window.gsap && cards.length) {
          gsap.fromTo(cards, { autoAlpha: 0, y: 14 },
            { autoAlpha: 1, y: 0, duration: 0.4, stagger: 0.03, ease: "power3.out" });
        }
        initCardGlow();
        if (window.ScrollTrigger) ScrollTrigger.refresh();
      } catch (e) {
        // Nothing changed on screen, so the pressed state rolls back with it.
        if (token === inflight) paint(current);
        toast("排序切换失败，请重试");
      } finally {
        if (token === inflight) {
          btn.classList.remove("is-loading");
          panel.classList.remove("is-swapping");
        }
      }
    });
  });
}

/* ================= search field glow =================
   Feeds the pointer's position to the field so its border lights up locally
   instead of uniformly. Two custom properties are written on pointermove and
   the gradient itself stays in CSS, so the whole effect is two property writes
   per move.

   The cards use a different mechanism — see initCardGlow. They are driven from
   their grid because a card is small enough that the pointer crosses in and out
   of it constantly, while the search field is one large element that owns its
   whole area. */
const GLOW_FADE_MS = 300;

function attachFieldGlow(el) {
  if (el.__glowBound) return;
  el.__glowBound = true;

  // Whether the pointer is over this element at all. `pointermove` bubbles, so
  // without this the field would also react to a move that happened somewhere
  // else entirely; testing the real event path keeps the light tied to the
  // element it belongs to.
  const isOver = (e) => e.composedPath().includes(el);

  el.addEventListener("pointermove", (e) => {
    if (!isOver(e)) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", (e.clientX - r.left) + "px");
    el.style.setProperty("--my", (e.clientY - r.top) + "px");
    // `glow-on` is what actually reveals it, so the light never appears before
    // there is a position to place it at.
    el.classList.add("glow-on");
    // A move inside cancels any fade still counting down: crossing onto the
    // input or the button fires pointerleave on the form, and without this the
    // light would drop out mid-crossing and read as a flicker.
    clearTimeout(el.__glowTimer);
  });

  el.addEventListener("pointerleave", () => {
    // Faded even while the field holds focus. Holding it was meant for tabbing
    // in without a pointer, but it also caught the ordinary case — click the
    // field, move the mouse away — and the light then stayed lit indefinitely
    // because focus outlives the pointer. The light belongs to the pointer, so
    // it leaves when the pointer does; a keyboard focus gets its own light from
    // the focusin handler below, which does not depend on a stale position.
    fadeGlow(el);
  });

  el.addEventListener("focusin", (e) => {
    // Only for focus that arrives without a pointer — tabbing in. A pointer
    // click also focuses the field, and re-lighting on it there would fight the
    // fade that the matching pointerleave just started.
    if (e.detail === 0 || el.matches(":hover")) {
      if (el.style.getPropertyValue("--mx")) el.classList.add("glow-on");
    }
  });
  el.addEventListener("focusout", () => fadeGlow(el));

  return el;
}

/* Every card on the page picks up the same light as the search field.

   The listener lives on the grid, not on each card. Two reasons, both of which
   showed up as the light behaving wrongly around the gaps between cards:

   - A card only hears `pointermove` while the pointer is inside it. Crossing an
     18px gap therefore produced a flicker — this card's light died on
     `pointerleave`, and the next card's lit only once the pointer was already
     over it. Driving from the grid makes the whole surface continuous.
   - `pointerleave` fires on the card whenever the pointer crosses onto a child,
     which inside a card with an avatar and several text nodes is constantly.

   So the grid carries the listener, and each move is applied to every card in
   that grid. A card's own coordinates are only written when the pointer is
   genuinely within its bounds; cards the pointer is not over fade out. That
   keeps the "light follows the pointer" behaviour without ever lighting a card
   the pointer is not on.

   Cards are queried fresh each call because the grids are replaced wholesale
   when a tab switches; rebinding a grid already bound is a no-op. */
function initCardGlow() {
  const GLOWS = [
    { grid: ".repo-grid", card: ".repo-card", radius: 150 },
    { grid: ".people-grid", card: ".person-card", radius: 150 },
  ];
  GLOWS.forEach(({ grid, card, radius }) => {
    document.querySelectorAll(grid).forEach((g) => {
      if (g.__glowGrid) return;
      g.__glowGrid = true;

      const cardsIn = () => [...g.querySelectorAll(card)];

      g.addEventListener("pointermove", (e) => {
        cardsIn().forEach((el) => {
          const r = el.getBoundingClientRect();
          const inside = e.clientX >= r.left && e.clientX <= r.right &&
                         e.clientY >= r.top && e.clientY <= r.bottom;
          if (inside) {
            el.style.setProperty("--mx", (e.clientX - r.left) + "px");
            el.style.setProperty("--my", (e.clientY - r.top) + "px");
            el.classList.add("glow-on");
            clearTimeout(el.__glowTimer);
          } else if (el.classList.contains("glow-on")) {
            fadeGlow(el);
          }
        });
      });

      g.addEventListener("pointerleave", () => {
        cardsIn().forEach((el) => { if (el.classList.contains("glow-on")) fadeGlow(el); });
      });

      cardsIn().forEach((el) => el.style.setProperty("--glow-radius", radius + "px"));
    });
  });
}

/* Retiring `glow-on` starts the fade, but clearing --mx/--my at the same moment
   hands the gradient back to its CSS default, which is the centre — so the light
   slid to the middle on its way out instead of dying where the pointer left it.
   The last position is kept until the fade has finished. */
function fadeGlow(el) {
  el.classList.remove("glow-on");
  clearTimeout(el.__glowTimer);
  el.__glowTimer = setTimeout(() => {
    el.style.removeProperty("--mx");
    el.style.removeProperty("--my");
  }, GLOW_FADE_MS);
}

function initSearchGlow() {
  document.querySelectorAll(".search-big").forEach(attachFieldGlow);

  // Focus the field only when a query was submitted, where the caret is wanted;
  // the attribute is only rendered in that case.
  const q = document.querySelector("[data-autofocus-on-query]");
  if (q) setTimeout(() => q.focus(), 120);
}

/* ================= readme editor =================
   Opens over the repository instead of navigating to its own page. The old
   route rendered a full document for what is one textarea and two buttons, so
   editing meant leaving the files, comments and stats behind and coming back
   to them afterwards. The markup is built here and the text is fetched, while
   the POST still goes to the same route and redirects back to the repo. */
function initReadmeEditor() {
  const triggers = document.querySelectorAll(".readme-edit-open");
  if (!triggers.length) return;

  triggers.forEach((trigger) => {
    trigger.addEventListener("click", async () => {
      const owner = trigger.dataset.owner;
      const name = trigger.dataset.name;

      let data;
      try {
        const res = await fetch(`/api/r/${owner}/${encodeURIComponent(name)}/readme`);
        if (!res.ok) { toast("无法读取 README"); return; }
        data = await res.json();
      } catch (e) { toast("网络错误，请重试"); return; }

      const wrap = document.createElement("div");
      wrap.id = "readme-dialog";
      wrap.className = "modal-page";
      wrap.innerHTML = [
        '<div class="preview-backdrop" data-readme-close></div>',
        '<form class="auth-card modal-card readme-modal-card" method="post"',
        '      action="/r/' + owner + '/' + encodeURIComponent(name) + '/readme/edit"',
        '      role="dialog" aria-modal="true" aria-label="编辑 README">',
        '  <h1 class="auth-title">编辑 README</h1>',
        '  <p class="auth-sub">' + owner + ' / ' + name + ' · 支持 Markdown：' +
             '<code># 标题</code>、<code>**加粗**</code>、<code>- 列表</code>、' +
             '<code>```代码块```</code>、<code>[链接](url)</code>' +
             (data.exists ? '' : '<br><strong>保存后将自动创建 README.md</strong>') + '</p>',
        '  <textarea id="readme-content" name="content" rows="20" spellcheck="false"',
        '    placeholder="# 我的仓库&#10;&#10;介绍一下这里放了什么…"></textarea>',
        '  <div class="editor-foot">',
        '    <span class="editor-count" id="editor-count">0 字符</span>',
        '    <div class="editor-actions">',
        '      <button type="button" class="btn btn-ghost" data-readme-close>取消</button>',
        '      <button type="submit" class="btn btn-green">保存 README</button>',
        '    </div>',
        '  </div>',
        '  <button type="button" class="dialog-x" data-readme-close aria-label="关闭">&#10005;</button>',
        '</form>',
      ].join("");
      document.body.appendChild(wrap);

      const area = wrap.querySelector("#readme-content");
      const count = wrap.querySelector("#editor-count");
      // The text goes in through the value property, not into the markup: a
      // README containing "</textarea>" would otherwise break out of the field.
      area.value = data.content;
      const sync = () => { count.textContent = area.value.length + " 字符"; };
      area.addEventListener("input", sync);
      sync();

      const close = (immediate) => {
        if (immediate) { wrap.remove(); return; }
        gsap.to(wrap.querySelector(".modal-card"),
          { autoAlpha: 0, y: 20, scale: 0.97, duration: 0.22, ease: "power2.in" });
        gsap.to(wrap.querySelector(".preview-backdrop"),
          { autoAlpha: 0, duration: 0.22, onComplete: () => wrap.remove() });
      };
      wrap.querySelectorAll("[data-readme-close]").forEach((el) => {
        el.addEventListener("click", (e) => { e.preventDefault(); close(); });
      });
      const onEsc = (e) => {
        if (e.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); }
      };
      document.addEventListener("keydown", onEsc);

      gsap.fromTo(wrap.querySelector(".preview-backdrop"),
        { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25 });
      gsap.fromTo(wrap.querySelector(".modal-card"),
        { autoAlpha: 0, y: 30, scale: 0.96 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.42, ease: "power3.out" });
      setTimeout(() => area.focus(), 120);
    });
  });
}

/* ================= in-page dialogs =================
   Login, register and new-repo are dialogs over the current page, not separate
   documents. Each used to be a full page carrying a `.modal-page` shell, so
   following a link left the page you were on: the URL changed, the site
   reloaded, and closing meant navigating again. They now open in place, like
   the login dialog already did, and the form still posts to the same server
   route — the server keeps its validation and error rendering either way.

   One factory builds them all. Each entry is markup plus an optional onOpen,
   so adding a fourth dialog later is a data change rather than new plumbing. */
const DIALOGS = {
  login: {
    title: "欢迎回来",
    sub: "登录 FileHub，继续管理你的文件仓库",
    action: "/login",
    body: [
      '<label class="field">用户名<input type="text" name="username" required autocomplete="username"></label>',
      '<label class="field">密码',
      '  <span class="pw-wrap">',
      '    <input type="password" name="password" required autocomplete="current-password" id="dlg-pw-login">',
      '    <button type="button" class="pw-toggle" data-target="dlg-pw-login" aria-label="显示密码">&#128065;</button>',
      '  </span>',
      '</label>',
    ].join(""),
    submit: "登 录",
    alt: '还没有账号？<a href="#" data-dialog-open="register">立即注册</a>',
    focus: 'input[name="username"]',
  },
  register: {
    title: "加入 FileHub",
    sub: "免费创建账号，托管你的每一份自定义文件",
    action: "/register",
    body: [
      '<label class="field">用户名',
      '  <input type="text" name="username" required autocomplete="username"',
      '         pattern="[A-Za-z0-9_-]{2,32}" title="2-32 位字母、数字、下划线或连字符">',
      '</label>',
      '<label class="field">密码（至少 6 位）',
      '  <span class="pw-wrap">',
      '    <input type="password" name="password" required minlength="6" autocomplete="new-password" id="dlg-pw-reg">',
      '    <button type="button" class="pw-toggle" data-target="dlg-pw-reg" aria-label="显示密码">&#128065;</button>',
      '  </span>',
      '</label>',
    ].join(""),
    submit: "注 册",
    alt: '已有账号？<a href="#" data-dialog-open="login">直接登录</a>',
    focus: 'input[name="username"]',
  },
  newrepo: {
    title: "新建仓库",
    sub: "给一批文件一个家",
    action: "/new",
    body: [
      '<label class="field">仓库名（支持中文、字母、数字、常用符号）',
      '  <input type="text" name="name" required maxlength="64" placeholder="设计稿 / my-assets / 3d-models">',
      '</label>',
      '<label class="field">描述（可选）',
      '  <textarea name="description" rows="3" maxlength="500" placeholder="这个仓库里放了什么？"></textarea>',
      '</label>',
      '<label class="field-check">',
      '  <input type="checkbox" name="is_private" value="1">',
      '  <span>🔒 设为私有仓库（仅自己可见）</span>',
      '</label>',
    ].join(""),
    submit: "创建仓库",
    alt: '或者 <a href="#" data-dialog-close>返回</a>',
    focus: 'input[name="name"]',
  },
};

let openDialogName = null;

function openDialog(name) {
  const spec = DIALOGS[name];
  if (!spec) return;
  closeDialog(true);

  // A server-side validation failure re-renders the page with the error on the
  // body, and reopening the dialog has to show it — otherwise the form comes
  // back empty with no explanation of what was wrong.
  const host = document.querySelector("[data-dialog-error]");
  const errorText = host ? host.dataset.dialogError : "";

  const wrap = document.createElement("div");
  wrap.id = "app-dialog";
  wrap.className = "modal-page";
  wrap.dataset.dialog = name;
  wrap.innerHTML = [
    '<div class="preview-backdrop" data-dialog-close></div>',
    '<div class="auth-card modal-card" role="dialog" aria-modal="true" aria-label="' + spec.title + '">',
    '  <h1 class="auth-title">' + spec.title + '</h1>',
    '  <p class="auth-sub">' + spec.sub + '</p>',
    '  <form method="post" action="' + spec.action + '" class="dialog-form">',
    errorText
      ? '    <p class="form-error">' + errorText.replace(/[<>&]/g, function (c) {
          return { "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c];
        }) + '</p>'
      : "",
    spec.body,
    '    <button type="submit" class="btn btn-green btn-block btn-lg">' + spec.submit + '</button>',
    '  </form>',
    '  <p class="auth-alt">' + spec.alt + '</p>',
    '  <button type="button" class="dialog-x" data-dialog-close aria-label="关闭">&#10005;</button>',
    '</div>',
  ].join("");
  document.body.appendChild(wrap);
  openDialogName = name;

  wrap.querySelectorAll("[data-dialog-close]").forEach(function (el) {
    el.addEventListener("click", function (e) { e.preventDefault(); closeDialog(); });
  });
  // Switching between login and register swaps the dialog in place rather than
  // appending a second one on top, so the two are one surface with two faces.
  wrap.querySelectorAll("[data-dialog-open]").forEach(function (el) {
    el.addEventListener("click", function (e) {
      e.preventDefault();
      openDialog(el.dataset.dialogOpen);
    });
  });
  wrap.querySelectorAll(".pw-toggle").forEach(function (btn) {
    btn.addEventListener("click", function () {
      const input = document.getElementById(btn.dataset.target);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.classList.toggle("on", show);
      input.focus();
    });
  });

  const card = wrap.querySelector(".modal-card");
  gsap.fromTo(wrap.querySelector(".preview-backdrop"), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25 });
  gsap.fromTo(card,
    { autoAlpha: 0, y: 30, scale: 0.96 },
    { autoAlpha: 1, y: 0, scale: 1, duration: 0.42, ease: "power3.out" });

  // Submit in place. A plain POST reloads the document, which closes the dialog
  // and either lands on a new page or re-renders the shell — either way the user
  // loses what they typed. Fetching keeps the form on screen, shows the error
  // inside it, and only navigates when the server actually succeeded.
  const form = wrap.querySelector("form");
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    submitDialog(form);
  });

  // Focus after the intro tween has started, or the caret appears before the
  // card has settled and the browser scrolls to it mid-animation.
  const first = wrap.querySelector(spec.focus);
  if (first) setTimeout(function () { first.focus(); }, 120);
}

/* Post a dialog's form without leaving the page.
   The server answers with a redirect on success and an error page on failure —
   both are the existing contract, so this reads the response rather than
   needing a JSON API: a redirect means "go there", anything else means "read
   the message out of the returned markup and show it here". */
async function submitDialog(form) {
  const btn = form.querySelector('button[type="submit"]');
  const card = form.closest(".modal-card");
  const label = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "处理中…"; }

  const clearError = () => {
    const old = card.querySelector(".form-error");
    if (old) old.remove();
  };
  clearError();

  try {
    const res = await fetch(form.action, {
      method: "POST",
      body: new FormData(form),
      redirect: "follow",
    });
    // A successful login or signup ends on a different URL; following the
    // redirect means res.url points there. Compare against where we started.
    if (res.ok && res.redirected) {
      window.location.href = res.url;
      return;
    }
    if (res.ok && !res.redirected) {
      // Same-URL 200: the route rendered a page rather than redirecting, which
      // for these forms means it succeeded without a destination change.
      window.location.reload();
      return;
    }
    // Failure: pull the message out of the rendered error page. These routes
    // render a shell whose only payload is data-dialog-error, so look there
    // first and fall back to any .form-error the markup might carry.
    let message = "提交失败，请检查填写内容";
    try {
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const host = doc.querySelector("[data-dialog-error]");
      const shown = doc.querySelector(".form-error");
      if (host && host.dataset.dialogError) message = host.dataset.dialogError.trim();
      else if (shown) message = shown.textContent.trim();
    } catch (e) { /* keep the fallback */ }

    const p = document.createElement("p");
    p.className = "form-error";
    p.textContent = message;
    form.insertBefore(p, form.firstChild);
    // Replay the shake-free entrance so the error is noticed without a jolt.
    gsap.fromTo(p, { autoAlpha: 0, y: -6 }, { autoAlpha: 1, y: 0, duration: 0.3, ease: "power2.out" });
  } catch (err) {
    const p = document.createElement("p");
    p.className = "form-error";
    p.textContent = "网络错误，请重试";
    form.insertBefore(p, form.firstChild);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

function closeDialog(immediate) {
  const wrap = document.getElementById("app-dialog");
  openDialogName = null;
  if (!wrap) return;
  if (immediate) { wrap.remove(); return; }
  gsap.to(wrap.querySelector(".modal-card"), {
    autoAlpha: 0, y: 20, scale: 0.97, duration: 0.22, ease: "power2.in",
  });
  gsap.to(wrap.querySelector(".preview-backdrop"), {
    autoAlpha: 0, duration: 0.22,
    onComplete: function () { wrap.remove(); },
  });
}

/* Any element carrying data-dialog-open="login|register|newrepo" opens that
   dialog in place. This is what converts the old page links into in-page
   dialogs without touching each template's markup beyond the attribute. */
function initDialogTriggers() {
  document.addEventListener("click", function (e) {
    const trigger = e.target.closest("[data-dialog-open]");
    if (!trigger) return;
    // Links inside a dialog only swap dialogs; handled by openDialog itself.
    if (trigger.closest("#app-dialog")) return;
    e.preventDefault();
    openDialog(trigger.dataset.dialogOpen);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && openDialogName) closeDialog();
  });
  // A server-side validation failure re-renders the page with an error, and the
  // user should land back in the dialog they were filling in rather than on a
  // bare form. Direct visits to /login, /register and /new work the same way:
  // those routes render an empty shell whose only job is to ask for the dialog.
  //
  // Read from the whole document, not body: the attribute is written on the
  // page's <main>, and looking for it only on <body> meant it never matched —
  // those routes rendered as a blank page with no dialog at all.
  const host = document.querySelector("[data-dialog-reopen]");
  const reopen = host && host.dataset.dialogReopen;
  if (reopen && DIALOGS[reopen]) openDialog(reopen);
}


/* ================= v18: logout confirmation ================= */

function initLogoutConfirm() {
  const form = document.getElementById("logout-form");
  if (!form) return;
  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    const ok = await askConfirm("退出登录", "确定要退出当前账号吗？", "退出");
    if (!ok) return;
    HTMLFormElement.prototype.submit.call(form);
  });
}

/* ================= v14: always start at the home page ================= */

/* Closing the site and reopening it must land on the home page (the splash
   page), never on whatever was open last. Nothing is persisted across visits,
   and any leftover state from an earlier build is cleared here so a stale
   "return to last page" cannot fire. */
function clearStaleRestoreState() {
  // Drop only the keys left behind by the removed "return to last page"
  // feature. "fh-intro-seen" is deliberately kept: the splash must play once
  // per browsing session, not on every page transition.
  try {
    ["fh-last-page", "fh-restore-done"].forEach(function (k) {
      sessionStorage.removeItem(k);
    });
  } catch (e) { /* private mode: nothing stored anyway */ }
}

function showRestoreIsland() { /* instant navigation is gone by design */ }

/* ================= returning to a page =================
   Going back must show the page as it is now, not as it was when you left it.

   Two browser behaviours get in the way, and they need separate handling:

   1. Scroll restoration. The browser re-applies the scroll position you left
      behind, so you land halfway down a page whose content may have changed.
      Turning it off means a returned-to page starts at the top, like a fresh
      visit. (ScrollSmoother keeps its own offset, so it is reset too — it does
      not follow the native scroll position.)

   2. The back/forward cache. A page restored from bfcache is the old DOM, with
      everything you had typed or expanded still in it. The server sends
      `no-store` for this reason, but Chromium still places such pages in
      bfcache and may serve them without a network round trip. `pageshow` with
      `persisted: true` is the signal that this happened; reloading is the only
      way to guarantee fresh content. It is a reload, not a forced one, so a
      genuinely cached page still resolves from the cache if the server allows
      it — and the server does not. */
function initBackNavigationReset() {
  // Reloading on restore means this runs again on the fresh page, where the
  // setting is re-applied, so there is nothing to restore later.
  history.scrollRestoration = "manual";

  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;             // a normal load — nothing to redo
    location.reload();
  });

  // ScrollSmoother holds the scroll position in its own transform, so clearing
  // the native one is not enough on pages that use it.
  window.addEventListener("pageshow", () => {
    const sm = window.ScrollSmoother && window.ScrollSmoother.get
      ? window.ScrollSmoother.get() : null;
    if (sm && sm.scrollTop()) sm.scrollTop(0);
  });
}

/* ================= boot =================
   Every initialiser runs here, after the whole module body has been
   evaluated, so no const/let declaration can be in its temporal dead zone. */
(function boot() {
  const legacy = localStorage.getItem("fh-motion");
  if (legacy !== null && localStorage.getItem("fh-set-motion") === null) {
    setSetting("motion", legacy === "off" ? "off" : "on");
    localStorage.removeItem("fh-motion");
  }
  applyAccentToGsap(getSetting("accent") || "#0ae448");
})();

applyTheme();
applyAppearanceSettings();
initSettingsPanel();
initPasswordToggle();
initGuestAvatar();
initDialogTriggers();
initDiscoverTabs();
initSortTabs();
initSearchGlow();
initCardGlow();
initReadmeEditor();
initConfirmModal();
initLogoutConfirm();
clearStaleRestoreState();
initBackNavigationReset();
initChat();
initCoverPicker();
initCoverForms();
initCoverFieldGlow();
initChatBgControls();
initChatBgLayer();
initProfileCustomisation();
initModalPages();
initFollowListButtons();
initSearchBox();
initCommentActions();

build();
initHeroTiles();

if (getSetting("pointer") === "on" && document.querySelector(".hero")) {
  initPointerEffect();
}
