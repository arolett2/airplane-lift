/** Common shape of the small UI components: an element, a way to push a value in, cleanup. */
export interface Control<T, E extends Element = HTMLElement> {
  /** Root element; the owner appends it and may add `data-param` to it. */
  readonly el: E;
  /** Show a value without emitting a change event. */
  set(value: T): void;
  /** Remove listeners and anything the component put outside `el`. */
  destroy(): void;
}
