/**
 * Dev-only support for hot updates (see main.ts). An update re-runs main.ts
 * with the edited modules, building a new game next to the old one's leftovers:
 * the old run's listeners on the page would still answer every key press, and
 * the UI would build its buttons twice. resetPage() clears both: listeners on
 * the long-lived targets (window, document and the 3D canvas) are tracked and
 * removed, and <body> goes back to the markup index.html shipped, apart from
 * the canvas, whose WebGL context holds the loaded world.
 *
 * Imported first by main.ts, so it sees the page before any game code runs.
 * Editing this file reloads the page (vite.config.ts).
 */

type Tracked = [EventTarget, string, EventListenerOrEventListenerObject, boolean | EventListenerOptions | undefined];

let tracked: Tracked[] = [];
let pristine: HTMLElement | null = null;

if (import.meta.hot) {
  pristine = document.body.cloneNode(true) as HTMLElement;
  const targets: EventTarget[] = [window, document, canvas()];
  for (const target of targets) {
    const add = target.addEventListener;
    target.addEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (listener) tracked.push([target, type, listener, options]);
      add.call(this, type, listener, options);
    };
  }
}

function canvas(): HTMLElement {
  return document.getElementById('view')!;
}

/** Undoes what the outgoing run hooked into the page; the canvas stays. */
export function resetPage(): void {
  if (!pristine) return;
  for (const [target, type, listener, options] of tracked) target.removeEventListener(type, listener, options);
  tracked = [];
  const body = pristine.cloneNode(true) as HTMLElement;
  // Shown once per page load, not per update.
  body.querySelector('#splash')?.remove();
  body.querySelector('#view')!.replaceWith(canvas());
  document.body.replaceWith(body);
}
