/**
 * Top bar: title, lessons / compare / smoke-pulse actions, camera shots, share, and the panel
 * toggles used on small screens.
 *
 * Panel toggles and toast messages talk to the surrounding AppShell through the DOM, so TopBar
 * has no hard dependency on it: it sets `data-panel` on the nearest `[data-shell]` ancestor and
 * dispatches a bubbling `shell:toast` event.
 */
import type { AppState, CameraShot } from '../../state/params';
import type { Store } from '../../state/store';
import { createIconButton } from '../components/iconButton';
import type { IconButtonControl } from '../components/iconButton';
import { icon } from '../components/icons';
import { Disposables, h, uid } from '../dom';
import { encodeState } from '../urlState';

export interface TopBarActions {
  onPulse(): void;
  onOpenLessons(): void;
  onOpenCompare(): void;
  /** Switch the 3D flow probe on or off (optional: no button without it). */
  onToggleProbe?(on: boolean): void;
}

export const TOP_BAR_TITLE = 'Wind Tunnel — How Wings Lift';

/** Event name AppShell listens for to show a toast. `detail` is the message. */
export const TOAST_EVENT = 'shell:toast';

const CAMERA_SHOTS: { value: CameraShot; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'side', label: 'Side view' },
  { value: 'front', label: 'Front view' },
  { value: 'top', label: 'From above' },
  { value: 'tip', label: 'Wingtip' },
  { value: 'behind', label: 'From behind' },
  { value: 'section', label: 'Cross-section' },
];

type DrawerPanel = 'left' | 'right';

export class TopBar {
  private readonly root: HTMLElement;
  private readonly store: Store<AppState>;
  private readonly disposables = new Disposables();
  private readonly buttons: IconButtonControl[] = [];
  private readonly camera: HTMLSelectElement;
  private readonly share: IconButtonControl;
  private readonly probe: IconButtonControl | null = null;
  private probeOn = false;
  private readonly panelButtons = new Map<DrawerPanel, IconButtonControl>();
  private shareTimer: ReturnType<typeof setTimeout> | null = null;
  private localPanel: DrawerPanel | null = null;

  constructor(root: HTMLElement, store: Store<AppState>, actions: TopBarActions) {
    this.root = root;
    this.store = store;
    const { disposables } = this;

    const add = (button: IconButtonControl): HTMLButtonElement => {
      this.buttons.push(button);
      disposables.add(() => button.destroy());
      return button.el;
    };

    const controlsToggle = this.makePanelToggle('left', 'sliders', 'Controls');
    const readoutsToggle = this.makePanelToggle('right', 'numbers', 'Results');

    const cameraId = uid('camera');
    this.camera = h(
      'select',
      { class: 'topbar__camera-select', id: cameraId, 'aria-label': 'Camera view' },
      ...CAMERA_SHOTS.map((c) => h('option', { value: c.value }, c.label)),
    );
    this.camera.value = store.get().view.camera;
    disposables.listen(this.camera, 'change', () => {
      const shot = this.camera.value as CameraShot;
      this.store.set((s) =>
        s.view.camera === shot ? s : { ...s, view: { ...s.view, camera: shot } },
      );
    });

    this.share = createIconButton({
      icon: 'share',
      label: 'Copy a link to this wing',
      text: 'Share',
      onClick: () => void this.copyLink(),
    });

    const lessons = add(
      createIconButton({
        icon: 'book',
        label: 'Open the guided lessons',
        text: 'Lessons',
        variant: 'accent',
        onClick: () => actions.onOpenLessons(),
      }),
    );
    const compare = add(
      createIconButton({
        icon: 'compare',
        label: 'Compare two aircraft side by side',
        text: 'Compare',
        onClick: () => actions.onOpenCompare(),
      }),
    );
    const pulse = add(
      createIconButton({
        icon: 'pulse',
        label: 'Release a smoke pulse to see how the air moves',
        text: 'Smoke pulse',
        onClick: () => actions.onPulse(),
      }),
    );
    const share = add(this.share);
    let probe: HTMLButtonElement | null = null;
    if (actions.onToggleProbe) {
      const toggle = actions.onToggleProbe;
      this.probe = createIconButton({
        icon: 'probe',
        label: 'Probe the air: click a point in the tunnel to read its speed and pressure',
        text: 'Probe',
        pressed: false,
        class: 'topbar__probe',
        onClick: () => toggle(!this.probeOn),
      });
      probe = add(this.probe);
    }

    root.classList.add('topbar');
    root.append(
      h(
        'div',
        { class: 'topbar__left' },
        controlsToggle,
        h('h1', { class: 'topbar__title' }, TOP_BAR_TITLE),
      ),
      h(
        'div',
        { class: 'topbar__actions' },
        lessons,
        compare,
        pulse,
        probe,
        h('label', { class: 'topbar__camera', for: cameraId }, icon('camera', 18), this.camera),
        share,
        readoutsToggle,
      ),
    );

    disposables.add(
      store.select(
        (s) => s.view.camera,
        (shot) => {
          this.camera.value = shot;
        },
      ),
    );

    // Reflect which drawer is open (set by AppShell, or by us when used stand-alone).
    const shell = this.shell();
    if (shell && typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(() => this.syncPanelButtons());
      observer.observe(shell, { attributes: true, attributeFilter: ['data-panel'] });
      disposables.add(() => observer.disconnect());
    }
    this.syncPanelButtons();
  }

  /** Reflect whether the 3D probe is on (the app owns that state). */
  setProbeActive(on: boolean): void {
    this.probeOn = on;
    this.probe?.set(on);
  }

  destroy(): void {
    if (this.shareTimer !== null) clearTimeout(this.shareTimer);
    this.disposables.dispose();
    this.root.classList.remove('topbar');
    this.root.replaceChildren();
  }

  /* -------------------------------------------------------------------------------------- */

  private shell(): HTMLElement | null {
    return this.root.closest<HTMLElement>('[data-shell]');
  }

  private openPanel(): DrawerPanel | null {
    const shell = this.shell();
    const value = shell ? shell.dataset.panel : this.localPanel;
    return value === 'left' || value === 'right' ? value : null;
  }

  private makePanelToggle(panel: DrawerPanel, iconName: 'sliders' | 'numbers', label: string) {
    const button = createIconButton({
      icon: iconName,
      label: `Show ${label.toLowerCase()}`,
      class: `topbar__panel-toggle topbar__panel-toggle--${panel}`,
      onClick: () => {
        const next = this.openPanel() === panel ? null : panel;
        const shell = this.shell();
        if (shell) shell.dataset.panel = next ?? 'none';
        else this.localPanel = next;
        this.syncPanelButtons();
      },
    });
    button.el.setAttribute('aria-controls', panel === 'left' ? 'panel-left' : 'panel-right');
    this.panelButtons.set(panel, button);
    this.disposables.add(() => button.destroy());
    return button.el;
  }

  private syncPanelButtons(): void {
    const open = this.openPanel();
    for (const [panel, button] of this.panelButtons) {
      const isOpen = open === panel;
      button.el.setAttribute('aria-expanded', String(isOpen));
      button.el.classList.toggle('is-active', isOpen);
    }
  }

  /** Link that reproduces the current wing, conditions and view when opened. */
  private shareUrl(): string {
    const base = location.href.split('#')[0] ?? location.href;
    return `${base}#${encodeState(this.store.get())}`;
  }

  private async copyLink(): Promise<void> {
    const url = this.shareUrl();
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        copied = true;
      }
    } catch {
      /* fall through to the legacy path */
    }
    if (!copied) copied = legacyCopy(url);

    const message = copied ? 'Link copied. Anyone who opens it sees this wing.' : url;
    this.root.dispatchEvent(
      new CustomEvent<string>(TOAST_EVENT, { detail: message, bubbles: true }),
    );
    this.share.setLabel(copied ? 'Link copied' : 'Copy failed', copied ? 'Copied' : 'Share');
    if (this.shareTimer !== null) clearTimeout(this.shareTimer);
    this.shareTimer = setTimeout(() => {
      this.share.setLabel('Copy a link to this wing', 'Share');
      this.shareTimer = null;
    }, 2000);
  }
}

/** Clipboard fallback for insecure contexts (plain http, older browsers). */
function legacyCopy(text: string): boolean {
  const area = h('textarea', { 'aria-hidden': 'true', readonly: true, class: 'sr-only' });
  area.value = text;
  document.body.append(area);
  area.select();
  let ok: boolean;
  try {
    ok = typeof document.execCommand === 'function' && document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}
