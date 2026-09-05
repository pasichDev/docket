/**
 * The two lookups every DOM module needs, with the null case named once.
 *
 * The page's own markup is a fixed asset shipped alongside this code, so a missing element
 * is a bug in the build rather than a condition to handle at each call site — but it should
 * still say which selector, not fail three lines later on a null.
 */
export function el<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`the page is missing ${selector}`);
  return found;
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`the page is missing #${id}`);
  return found as T;
}

/** For elements that are genuinely optional — a panel that only exists for the host, say. */
export const maybe = <T extends Element = HTMLElement>(selector: string): T | null => document.querySelector<T>(selector);
