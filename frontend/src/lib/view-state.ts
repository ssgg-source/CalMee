// Session-only UI memory, deliberately separate from saved document content.
const values = new Map<string, unknown>();
export function readViewState<T>(key: string): T | undefined { return values.get(key) as T | undefined; }
export function writeViewState<T>(key: string, value: T) {
  values.delete(key); values.set(key, value);
  if (values.size > 100) values.delete(values.keys().next().value!);
}
export type ReadingPosition = { scrollTop: number; anchor?: string; offset: number };
export function captureReadingPosition(container: HTMLElement, nodes: Iterable<[string, HTMLElement | null]>): ReadingPosition {
  const top = container.getBoundingClientRect().top;
  for (const [anchor, element] of nodes) {
    if (element && element.getBoundingClientRect().bottom > top + 8)
      return { scrollTop: container.scrollTop, anchor, offset: element.getBoundingClientRect().top - top };
  }
  return { scrollTop: container.scrollTop, offset: 0 };
}
export function restoreReadingPosition(container: HTMLElement, position: ReadingPosition, anchor?: HTMLElement | null) {
  container.scrollTop = anchor
    ? container.scrollTop + anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - position.offset
    : position.scrollTop;
}
