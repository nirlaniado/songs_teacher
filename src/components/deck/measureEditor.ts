/** The slice of a textarea that measuring touches, so the logic can be tested without a DOM. */
export interface MeasurableField {
  style: { height: string; width: string };
  readonly scrollHeight: number;
  readonly scrollWidth: number;
}

/**
 * The inline editor's natural content size. Height and width are collapsed before reading,
 * because `scrollHeight`/`scrollWidth` only report the box's current size back once content
 * fits in it — so a box that grew could never shrink.
 *
 * The collapsed values are restored straight after. React writes a style only when the
 * value it renders changes, and a keystroke that doesn't change the box size renders the
 * same value again — so whatever measuring left in the DOM would stay there. Left as
 * `1px`/`auto`, that hid a tab's text and cut every editor to two rows until editing ended.
 */
export function measureEditor(field: MeasurableField, measureWidth: boolean): { height: number; width: number | null } {
  const { height, width } = field.style;
  field.style.height = "auto";
  const naturalHeight = field.scrollHeight;
  field.style.height = height;
  if (!measureWidth) return { height: naturalHeight, width: null };
  field.style.width = "1px";
  const naturalWidth = field.scrollWidth;
  field.style.width = width;
  return { height: naturalHeight, width: naturalWidth };
}
