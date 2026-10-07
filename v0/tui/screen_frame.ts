/** Pure composed rows for layout inspection; production output uses ScrollbackFrame. */
export interface ScreenFrame {
  readonly rows: readonly string[];
  readonly cursor: { readonly row: number; readonly cell: number };
  readonly size: { readonly columns: number; readonly rows: number };
  /** Identifies the Core epoch and Session represented by this frame. */
  readonly scope: string;
  /** Advances on every resize notification, including a return to the same dimensions. */
  readonly geometryGeneration: number;
}
