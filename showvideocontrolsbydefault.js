// =============================
// Content script: show controls
// =============================
// This script runs on webpages (as a content script). It:
// 1) Reads the user's settings ONCE and decides whether this site is enabled.
// 2) Only when enabled: turns on native <video> controls and, on a few sites,
//    removes overlays that block clicks.
// 3) Only when enabled: watches the DOM for newly added videos/overlays.
// 4) Only when enabled AND the user turned on "Block autoplay": pauses videos
//    that start playing without a person having asked for it.
//
// Performance notes (why the script is written this way):
// - When the site is disabled (excluded, or not in the include-only list) the
//   script does no DOM work at all: no MutationObserver, no scans. Its only
//   remaining cost is one idle storage listener.
// - Settings are read once and cached. They are never read per DOM mutation.
// - The observer only inspects nodes that were ADDED, never the whole document,
//   and batches the work into at most one run per animation frame. Browsers
//   pause animation frames in background tabs, so hidden tabs cost nothing.
// - Autoplay blocking is event driven: two rare media events, no timers, no
//   polling, and nothing at all while the option is off (the default).
//
// Behavior is controlled by values stored in the extension's local storage
// (storage.local, reached through the `api` alias defined below):
// - mode: 'exclude' (default) or 'include'.
// - excludedDomains: in exclude mode, the sites where the add-on stays off.
// - includedDomains: in include mode, the only sites where the add-on runs.
// - blockAutoplay: true to pause videos that start without user interaction.
//   Anything other than the boolean true (including a missing key) means off.
//
// Excluded pages inside a site: Instagram's Explore section (/explore) is
// off, because its video grid must stay clickable. The script checks the path
// on load and after in-app moves, which do not reload the page. It is handled
// here, not in the manifest, so that leaving Explore brings the add-on back.

(() => {
	'use strict';

	// Firefox exposes the promise-based `browser` namespace; Chrome, Edge and
	// other Chromium browsers expose `chrome`, which also returns promises in
	// Manifest V3. Resolved once, inside this closure, so nothing leaks into the page.
	const api = globalThis.browser ?? globalThis.chrome;

	const SETTINGS_KEYS = ['mode', 'excludedDomains', 'includedDomains', 'blockAutoplay'];

	// The browser's record of real clicks, taps and key presses on this page.
	// Used to tell a video the user started from one the page started by itself.
	// If an engine lacks it, autoplay blocking stays inert instead of guessing,
	// so videos are never paused for the wrong reason.
	const userActivation = navigator.userActivation || null;

	// Computed once per page: the hostname never changes for this document.
	const hostname = window.location.hostname.toLowerCase();

	// Strict host checks (exact host or a real subdomain). A plain substring
	// check could match look-alike hosts such as "9gag.com.example.net".
	const isNineGag = hostMatches(hostname, '9gag.com');
	const isInstagram = hostMatches(hostname, 'instagram.com');
	const hasSiteFixes = isNineGag || isInstagram;

	// Marks videos whose controls THIS script turned on, so that disabling can
	// undo exactly those and never touch controls the page provided itself.
	const ADDED_MARK = 'data-svc-added';

	let active = false; // True only while the add-on is enabled on this page.
	let observer = null; // Active MutationObserver, or null while disabled.
	let pendingNodes = []; // Added elements waiting for the next batch.
	let frameId = 0; // Pending requestAnimationFrame id, or 0.
	let syncCounter = 0; // Lets a newer settings read win over an older one.
	let firstSync = true; // True until the first settings read has been applied.
	let blockingAutoplay = false; // True only while the autoplay listeners are attached.
	let allowedBySettings = false; // Stored settings allow this site (page path not yet checked).
	let blockAutoplayWanted = false; // Stored blockAutoplay option, kept to re-apply on re-enable.
	let lastPath = window.location.pathname; // Last path seen, to detect in-app navigation.

	// ---------- Domain matching ----------

	// True if host equals domain or is one of its subdomains.
	// Example: 'instagram.com' matches 'instagram.com' and 'm.instagram.com'.
	function hostMatches(host, domain) {
		return host === domain || host.endsWith('.' + domain);
	}

	// Storage is treated as untrusted input: keep only non-empty strings,
	// lowercase them and drop a leading "www." so entries compare consistently.
	function normalizeList(value) {
		if (!Array.isArray(value)) return [];
		return value
			.filter(entry => typeof entry === 'string')
			.map(entry => entry.toLowerCase().replace(/^www\./, ''))
			.filter(entry => entry.length > 0);
	}

	// Decide from the stored settings whether the add-on acts on this site.
	// - Include mode: enabled only for domains in 'includedDomains'.
	// - Exclude mode: enabled everywhere except domains in 'excludedDomains'.
	function isEnabledFor(data) {
		if (data.mode === 'include') {
			return normalizeList(data.includedDomains).some(d => hostMatches(hostname, d));
		}
		return !normalizeList(data.excludedDomains).some(d => hostMatches(hostname, d));
	}

	// ---------- Video controls ----------

	// Turn on native controls for one <video>, unless it has no usable source.
	function enableControls(video) {
		if (!active) return; // Safety net: never act while disabled.
		const controls = video.getAttribute('controls');
		if (controls !== null && controls !== 'false') return; // Already shown.
		// A <video> whose src attribute exists but is empty is not ready yet.
		if (video.hasAttribute('src') && !video.getAttribute('src')) return;
		video.setAttribute('controls', 'true');
		video.setAttribute(ADDED_MARK, 'true');
	}

	// Undo what enableControls() did. Only marked videos are touched.
	function removeAddedControls() {
		document.querySelectorAll('video[' + ADDED_MARK + ']').forEach(video => {
			video.removeAttribute('controls');
			video.removeAttribute(ADDED_MARK);
		});
	}

	// Handle one added element: the element itself, or videos nested inside it.
	function processNode(node) {
		if (node.localName === 'video') {
			enableControls(node);
		} else if (node.firstElementChild) {
			// Skip childless elements; otherwise search only inside this subtree.
			for (const video of node.querySelectorAll('video')) {
				enableControls(video);
			}
		}
	}

	// ---------- Site-specific fixes ----------

	// Remove 9GAG overlay UI that may block clicks.
	function removeOverlays9gag() {
		document.querySelectorAll('.sound-toggle, .length, .presenting').forEach(element => {
			element.remove(); // element.style.display = 'none'; <- hiding instead is an option
		});
	}

	// On Instagram, stop generic overlay layers from intercepting clicks.
	// Elements with an empty class attribute (class="") stay clickable wrappers.
	function removeOverlaysInstagram() {
		const selector = 'div[data-visualcompletion="ignore"]:not([class=""]):not([data-igblock])';
		document.querySelectorAll(selector).forEach(element => {
			element.style.pointerEvents = 'none';
			element.setAttribute('data-igblock', 'true'); // Mark as processed.
		});
	}

	// On Instagram, lift the audio (mute) button above the native control bar,
	// which otherwise covers it. Instagram's class names are auto-generated and
	// change often, and the button is a <div role="button"> with a small <svg>,
	// so it is found by what it is and where it sits, never by class name.
	// Only videos this add-on gave controls to are considered.
	const IG_LIFT = '-40px'; // Roughly the height of the native control bar.

	const MAX_ICON_BOX = 56; // px; larger boxes are layout containers, not the icon unit.

	// Apply the lift to one element and mark it so it can be restored later.
	function liftElement(element) {
		element.style.transform = 'translateY(' + IG_LIFT + ')';
		element.setAttribute('data-igmarginfix', 'true');
	}

	const NO_COLOR = ['transparent', 'rgba(0, 0, 0, 0)'];

	// True if the element paints something behind its content (a background
	// colour or image, also through ::before / ::after): the "dark circle".
	function paintsBackdrop(element) {
		const own = getComputedStyle(element);
		if (!NO_COLOR.includes(own.backgroundColor) || own.backgroundImage !== 'none') return true;
		return ['::before', '::after'].some(pseudo => {
			const style = getComputedStyle(element, pseudo);
			return style.content !== 'none' && !NO_COLOR.includes(style.backgroundColor);
		});
	}

	// Collect what must move with an icon button: the button itself plus the
	// small elements that paint its circular backdrop, which may be a wrapper
	// around it or a sibling placed behind it. Nothing is moved just for being
	// small: a container only counts if it really draws a backdrop.
	function collectIconUnit(button, iconBox) {
		const found = new Set([button]);
		const centerX = iconBox.left + iconBox.width / 2;
		const centerY = iconBox.top + iconBox.height / 2;
		let node = button;
		for (let level = 0; level < 3 && node.parentElement; level++) {
			const parent = node.parentElement;
			const box = parent.getBoundingClientRect();
			// Stop at boxless or large parents: those are layout containers.
			if (box.width === 0 || box.height === 0) break;
			if (box.width > MAX_ICON_BOX || box.height > MAX_ICON_BOX) break;
			if (paintsBackdrop(parent)) found.add(parent);
			for (const sibling of parent.children) {
				if (sibling === node) continue;
				const s = sibling.getBoundingClientRect();
				const small = s.width > 0 && s.width <= MAX_ICON_BOX && s.height <= MAX_ICON_BOX;
				const behindIcon = centerX >= s.left && centerX <= s.right &&
					centerY >= s.top && centerY <= s.bottom;
				if (small && behindIcon && paintsBackdrop(sibling)) found.add(sibling);
			}
			node = parent;
		}
		// An element inside another lifted element already moves with it, and
		// lifting both would move it twice.
		return [...found].filter(a => ![...found].some(b => b !== a && b.contains(a)));
	}

	// Let the mouse reach the video through the transparent layers Instagram
	// stacks over it (tap-to-pause cover, caption rows). Without this the video
	// never receives hover or clicks, so its native controls cannot appear or be
	// used. The layers found at the control-bar height and at the middle of the
	// video are made click-through when they span the video's width. Small links
	// and buttons inside them keep working. Only layers ABOVE this video, at those
	// two points, are touched, so nothing else on the page is affected.
	function releaseVideoOverlays(video, videoBox) {
		if (typeof document.elementsFromPoint !== 'function') return; // Very old engines.
		const x = Math.round(videoBox.left + videoBox.width / 2);
		const probes = [
			Math.round(videoBox.bottom - 20), // where the control bar sits
			Math.round(videoBox.top + videoBox.height / 2)
		];
		const videoArea = videoBox.width * videoBox.height;
		const inDialog = dialogOpen();
		for (const y of probes) {
			// Hit-testing only works for points inside the visible window.
			if (x < 0 || x >= window.innerWidth || y < 0 || y >= window.innerHeight) continue;
			const stack = document.elementsFromPoint(x, y); // Topmost first.
			const videoIndex = stack.indexOf(video);
			for (let i = 0; i < videoIndex; i++) {
				const layer = stack[i];
				if (layer.contains(video)) continue; // Never disable a parent of the video.
				// Narrow elements are controls (icons), not covers: leave them alone.
				const layerBox = layer.getBoundingClientRect();
				if (layerBox.width < videoBox.width * 0.9) continue;
				// Inside a dialog, only a layer that sits on the video is a cover. Larger
				// ones (the dialog's own panels) are left alone: releasing them let hover
				// and clicks pass through to the grid underneath.
				if (inDialog && !sitsOnVideo(layerBox, videoBox)) continue;
				layer.style.pointerEvents = 'none';
				layer.setAttribute('data-igblock', 'true'); // Restored when disabled.
				// Pointer-events is inherited, so give small interactive children
				// (follow, links, icons) their clicks back. Large ones stay released.
				layer.querySelectorAll('a, button, [role="button"], input, textarea').forEach(item => {
					const box = item.getBoundingClientRect();
					if (box.width === 0 || box.width * box.height > videoArea * 0.25) return;
					item.style.pointerEvents = 'auto';
					item.setAttribute('data-igclick', 'true');
				});
			}
		}
	}

	// True while a dialog is open on the page, such as a post shown as a popup over
	// Explore. The dialog's own layers sit above the videos underneath, so changing
	// them (pointer-events) would let hover and clicks reach the page below. While a
	// dialog is open, only covers that sit exactly on a video are released (see
	// releaseVideoOverlays), and the page-wide overlay rule is skipped.
	function dialogOpen() {
		return document.querySelector('[role="dialog"]') !== null;
	}

	// True if a box lies on the video itself, within a few pixels: a cover.
	function sitsOnVideo(box, videoBox) {
		const tol = 4;
		return box.left >= videoBox.left - tol && box.right <= videoBox.right + tol &&
			box.top >= videoBox.top - tol && box.bottom <= videoBox.bottom + tol;
	}

	// Events Instagram uses to move between reels and posts (taps and clicks).
	const VIDEO_CLICK_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'touchend'];

	// Stops a click on a video from reaching Instagram, whose handlers treat it as
	// "next reel". This listener sits on the <video> itself, so it runs AFTER the
	// browser's own control bar has handled the event (the bar lives inside the
	// video), and stopPropagation does not cancel default actions. The native
	// controls keep working; only the page's handlers stop seeing these clicks.
	// Only while the add-on is active: on Explore and when disabled, nothing changes.
	function stopVideoClickBubbling(event) {
		if (active) event.stopPropagation();
	}

	// Attach the guard to one video. The same function reference is passed every
	// time, so the browser keeps a single listener per event and video.
	function guardInstagramVideo(video) {
		for (const type of VIDEO_CLICK_EVENTS) {
			video.addEventListener(type, stopVideoClickBubbling);
		}
	}

	function liftInstagramAudioButtons() {
		document.querySelectorAll('video[' + ADDED_MARK + ']').forEach(video => {
			guardInstagramVideo(video);
			const videoBox = video.getBoundingClientRect();
			if (videoBox.width === 0 || videoBox.height === 0) return; // Not laid out.
			releaseVideoOverlays(video, videoBox);

			// Search area: the feed post, or the main content on pages without
			// <article> (single reels). The position test below keeps only buttons
			// that really sit over this video, so a wide root is safe.
			const root = video.closest('article') ||
				video.closest('main, [role="main"]') || document.body;

			// Both real <button> elements (the tags icon) and role="button" divs
			// (the audio icon) are used for these controls.
			// Only buttons that hold an icon: this skips most of the page cheaply
			// before any layout measurement is done.
			root.querySelectorAll('button:has(svg), [role="button"]:has(svg)').forEach(button => {
				// Skip buttons already lifted. The lifted element carries the mark
				// (the button itself or one of its wrappers); its inline style proves
				// the lift still holds, since the page may re-render and wipe it.
				const lifted = button.closest('[data-igmarginfix]');
				if (lifted && lifted.style.transform) return;
				const icon = button.querySelector('svg');
				const box = button.getBoundingClientRect();
				if (!icon || box.width > MAX_ICON_BOX) return; // Small icon buttons only.

				// Must sit along the bottom edge of THIS video, on either side: the
				// audio button is at the bottom right and the tags icon at the bottom
				// left, and the native control bar covers both.
				const inBottomBand = box.bottom > videoBox.bottom - videoBox.height * 0.3 &&
					box.bottom <= videoBox.bottom + 2;
				const insideVideo = box.left >= videoBox.left - 2 &&
					box.right <= videoBox.right + 2;
				if (!inBottomBand || !insideVideo) return;

				// The dark circle behind the icon is not the button itself: it is a
				// wrapper or a sibling. Lift the whole visual unit so they move together.
				collectIconUnit(button, box).forEach(liftElement);

				// The add-on switches off click handling on Instagram's overlay layers
				// so the native controls stay usable. A button inside one of them
				// inherits that and would stop reacting, so it is given its own
				// clicks back. Only this small icon button, never the whole layer.
				button.style.pointerEvents = 'auto';
				button.setAttribute('data-igclick', 'true');
			});
		});
	}

	// Restore the Instagram changes made above. The 9GAG overlays were removed
	// from the page, so they can only come back with a page reload.
	function revertInstagramFixes() {
		document.querySelectorAll('[data-igblock]').forEach(element => {
			element.style.pointerEvents = '';
			element.removeAttribute('data-igblock');
		});
		document.querySelectorAll('[data-igmarginfix]').forEach(element => {
			element.style.transform = '';
			element.removeAttribute('data-igmarginfix');
		});
		document.querySelectorAll('[data-igclick]').forEach(element => {
			element.style.pointerEvents = '';
			element.removeAttribute('data-igclick');
		});
	}

	// Runs the fixes for the current site (no-op on every other site).
	// These fixes depend on third-party page markup, which changes without
	// notice. A failure here must never switch off the core feature (the video
	// controls), so errors are contained and the page is left as it is.
	function applySiteFixes() {
		if (!active) return;
		try {
			if (isNineGag) {
				removeOverlays9gag();
			}
			if (isInstagram) {
				if (!dialogOpen()) removeOverlaysInstagram();
				liftInstagramAudioButtons();
			}
		} catch (error) {
			// Intentionally ignored: see the comment above.
		}
	}

	// ---------- Autoplay blocking (optional, off by default) ----------

	// Videos whose CURRENT source a person started, or that were already playing
	// when blocking began. They may pause and resume freely, so the controls,
	// media keys and replay keep working. A WeakSet lets removed videos be
	// garbage collected.
	let userStarted = new WeakSet();

	// A video started (or resumed) playing. Pause it again unless a person is
	// behind it. "Behind it" means a click, tap or key press happened a moment
	// ago, which the browser reports as active user activation (about 5 seconds).
	// Only pause() is ever called: the page and the DOM are left as they are.
	function onVideoPlay(event) {
		const video = event.target;
		if (!video || video.localName !== 'video') return;
		if (userStarted.has(video)) return; // Already allowed for this source.
		if (userActivation.isActive) {
			userStarted.add(video); // The user pressed play: allow it from now on.
			return;
		}
		video.pause();
	}

	// The element dropped its source (a new one is about to load). Feeds such as
	// Instagram reels reuse one <video> for many clips, so each new source has to
	// earn its permission again. This is not tied to "loadstart" on purpose: that
	// event can fire right after the user's own first click and would take the
	// permission away from the video the user just started.
	function onVideoEmptied(event) {
		const video = event.target;
		if (video && video.localName === 'video') userStarted.delete(video);
	}

	// Begin blocking. Videos that are playing right now are handled once:
	// - On a freshly loaded page, with no interaction yet, they were started by
	//   the page itself, so they are paused.
	// - When the option is turned on later (from the popup), they are left alone
	//   and allowed to continue: the video someone is watching must not stop just
	//   because they opened the popup. Only later starts are blocked.
	function startBlockingAutoplay(pageJustLoaded) {
		if (blockingAutoplay) return;
		blockingAutoplay = true;
		// Media events do not bubble, hence the capturing listeners on the document.
		document.addEventListener('play', onVideoPlay, true);
		document.addEventListener('emptied', onVideoEmptied, true);

		const pausePlaying = pageJustLoaded && !userActivation.hasBeenActive;
		for (const video of document.getElementsByTagName('video')) {
			if (video.paused) continue;
			if (pausePlaying) {
				video.pause();
			} else {
				userStarted.add(video);
			}
		}
	}

	// Stop blocking and release everything. Videos paused earlier stay paused
	// (the page's own state is not guessed at); the controls start them again.
	function stopBlockingAutoplay() {
		if (!blockingAutoplay) return;
		blockingAutoplay = false;
		document.removeEventListener('play', onVideoPlay, true);
		document.removeEventListener('emptied', onVideoEmptied, true);
		userStarted = new WeakSet();
	}

	// Apply the stored option. Only called while the add-on is enabled on this
	// site, and a no-op without the user-activation API (see above).
	function setAutoplayBlocking(wanted) {
		if (wanted && userActivation) {
			startBlockingAutoplay(firstSync);
		} else {
			stopBlockingAutoplay();
		}
	}

	// ---------- Excluded pages inside a site ----------

	// Instagram's Explore section: /explore and everything under it, but not a
	// path that merely starts with the same letters (such as /explorer).
	const EXPLORE_PATH = /^\/explore(\/|$)/;

	// True when the add-on must stay off on the current page, whatever the settings say.
	function isOnExcludedPage() {
		return isInstagram && EXPLORE_PATH.test(window.location.pathname);
	}

	// ---------- DOM observation ----------

	// Process everything collected since the last frame in a single pass.
	function flushPending() {
		frameId = 0;
		const nodes = pendingNodes;
		pendingNodes = [];
		for (const node of nodes) {
			// Skip nodes that were detached again before this frame.
			if (node.isConnected) processNode(node);
		}
		if (hasSiteFixes) applySiteFixes();
	}

	// Called for every DOM change. Kept very cheap: it only queues added
	// elements and schedules one batched run per animation frame.
	function onMutations(mutations) {
		for (const mutation of mutations) {
			for (const node of mutation.addedNodes) {
				if (node.nodeType === Node.ELEMENT_NODE) pendingNodes.push(node);
			}
		}
		scheduleFlush();
	}

	// Make sure the queued work runs in the next animation frame (once).
	function scheduleFlush() {
		if (pendingNodes.length > 0 && frameId === 0) {
			frameId = requestAnimationFrame(flushPending);
		}
	}

	// A <video> that is already on the page can receive its source later, or
	// swap it for another one (single-page apps such as Instagram reels reuse
	// the same element). Videos without a source are skipped on purpose, and
	// the observer above only sees ADDED nodes, so the media's own "a source
	// was loaded" event is used to catch them. It fires rarely, so it is cheap.
	// The event does not bubble, hence the capturing listener on the document.
	function onMediaSourceLoaded(event) {
		const target = event.target;
		if (target && target.localName === 'video') {
			pendingNodes.push(target);
			scheduleFlush();
		}
	}

	// Start working on this page: handle existing videos, then watch for new ones.
	function enable() {
		if (active) return; // Already running.
		active = true;
		// Initial pass over what is already on the page.
		for (const video of document.getElementsByTagName('video')) {
			enableControls(video);
		}
		if (hasSiteFixes) applySiteFixes();

		observer = new MutationObserver(onMutations);
		// documentElement survives <body> being replaced by single-page apps.
		observer.observe(document.documentElement, { childList: true, subtree: true });
		document.addEventListener('loadstart', onMediaSourceLoaded, true);
		document.addEventListener('loadedmetadata', onMediaSourceLoaded, true);
	}

	// Stop all work on this page and release queued state.
	function disable() {
		if (!active) return; // Never enabled (or already disabled): nothing to undo.
		active = false;
		stopBlockingAutoplay(); // Disabled means disabled: no autoplay listeners either.
		if (observer) {
			observer.disconnect();
			observer = null;
		}
		document.removeEventListener('loadstart', onMediaSourceLoaded, true);
		document.removeEventListener('loadedmetadata', onMediaSourceLoaded, true);
		pendingNodes = [];
		if (frameId !== 0) {
			cancelAnimationFrame(frameId);
			frameId = 0;
		}
		// Leave the page as the site made it.
		removeAddedControls();
		if (isInstagram) revertInstagramFixes();
	}

	// ---------- Settings ----------

	// The single place that decides whether the add-on runs on this page. It uses
	// the cached settings only, so it is cheap to call on every page move.
	function applyDesiredState() {
		if (allowedBySettings && !isOnExcludedPage()) {
			enable();
			// Re-applied each time: leaving an excluded page turns the autoplay
			// listeners off, and coming back must restore them.
			setAutoplayBlocking(blockAutoplayWanted);
		} else {
			disable();
		}
	}

	// One storage read per call; the result is cached and then applied.
	async function syncWithSettings() {
		const myRun = ++syncCounter;
		try {
			const data = await api.storage.local.get(SETTINGS_KEYS);
			// A newer change arrived while this read was pending: let it decide.
			if (myRun !== syncCounter) return;
			allowedBySettings = isEnabledFor(data);
			// Strict boolean check: storage is untrusted input.
			blockAutoplayWanted = data.blockAutoplay === true;
		} catch (error) {
			// If settings cannot be read, do nothing rather than guess.
			allowedBySettings = false;
		}
		applyDesiredState();
		firstSync = false; // Later reads come from popup changes, not page loads.
	}

	// Runs after every move inside the app (Instagram is a single-page app). Only
	// the path is compared, so most calls end here without any other work.
	function onPossibleNavigation() {
		const path = window.location.pathname;
		if (path === lastPath) return;
		lastPath = path;
		applyDesiredState();
	}

	// Re-evaluate only when one of OUR keys changes in local storage. This lets
	// mode/list changes take effect without a reload and costs nothing otherwise.
	api.storage.onChanged.addListener((changes, area) => {
		if (area === 'local' && SETTINGS_KEYS.some(key => key in changes)) {
			syncWithSettings();
		}
	});

	// In-app navigation hooks, Instagram only (the one site with an excluded section).
	// The Navigation API reports every same-document move, including history.pushState
	// calls made by the page itself. Browsers without it get a fallback: the page
	// changes the URL while handling a click, so the path is checked after the click.
	if (isInstagram) {
		window.addEventListener('popstate', onPossibleNavigation);
		if (window.navigation) {
			window.navigation.addEventListener('navigatesuccess', onPossibleNavigation);
		} else {
			document.addEventListener('click', () => requestAnimationFrame(onPossibleNavigation), true);
		}
	}

	syncWithSettings();
})();