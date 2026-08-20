/**
 * Debounced preview controller — extracted from buildToolDef so hashline seams
 * stay pure and the debounce invariant is testable.
 * @module dsh-better-edit/preview-controller
 */
export const PREVIEW_DEBOUNCE_MS = 150;

export interface PreviewHost {
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  state: RRState;
  invalidate: () => void;
}

export type PreviewCompute = (args: unknown, cwd: string) => Promise<RPreview>;

export interface RPreview {
  error?: string;
  text?: string;
}

export interface RRState {
  argsKey?: string;
  preview?: RPreview;
  previewGeneration?: number;
  previewTimer?: ReturnType<typeof setTimeout>;
}

export function getPreviewInput(_args: unknown): unknown {
  return null;
}

export class DebouncedPreview {
  constructor(
    private readonly compute: PreviewCompute,
    private readonly debounceMs: number = PREVIEW_DEBOUNCE_MS,
  ) {}

  renderCall(host: PreviewHost, args: unknown): void {
    const { state } = host;
    const previewInput = getPreviewInput(args);
    if (host.executionStarted || !host.argsComplete || !previewInput) {
      this.cancel(state);
      return;
    }
    const argsKey = JSON.stringify(previewInput);
    if (state.argsKey === argsKey) return;
    this.cancel(state);
    state.argsKey = argsKey;
    const previewGeneration = (state.previewGeneration ?? 0) + 1;
    state.previewGeneration = previewGeneration;
    state.previewTimer = setTimeout(() => {
      state.previewTimer = undefined;
      this.compute(args, host.cwd)
        .then((preview) => {
          if (state.argsKey === argsKey && state.previewGeneration === previewGeneration) {
            state.preview = preview;
            host.invalidate();
          }
        })
        .catch((err: unknown) => {
          if (state.argsKey === argsKey && state.previewGeneration === previewGeneration) {
            state.preview = { error: err instanceof Error ? err.message : String(err) };
            host.invalidate();
          }
        });
    }, this.debounceMs);
  }

  cancel(state: RRState): void {
    if (state.previewTimer) {
      clearTimeout(state.previewTimer);
      state.previewTimer = undefined;
    }
    state.argsKey = undefined;
    state.preview = undefined;
    state.previewGeneration = (state.previewGeneration ?? 0) + 1;
  }

  clearResult(state: RRState): void {
    if (state.previewTimer) {
      clearTimeout(state.previewTimer);
      state.previewTimer = undefined;
    }
    state.preview = undefined;
    state.previewGeneration = (state.previewGeneration ?? 0) + 1;
  }
}
