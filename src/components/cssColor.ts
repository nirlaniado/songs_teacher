/** A semantic colour from index.css, resolved, for libraries that paint to a canvas and can't take `var()`. */
export function cssColor(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();
}
