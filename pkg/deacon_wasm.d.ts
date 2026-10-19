/* tslint:disable */
/* eslint-disable */

export class FilterSession {
    free(): void;
    [Symbol.dispose](): void;
    finish(): Uint8Array;
    constructor(index: WasmIndex, deplete: boolean, abs_threshold: number, rel_threshold: number, decompress_input: boolean, compress_output: boolean, rename: boolean, discard_quality: boolean);
    output_compressed(): boolean;
    pending_bytes(): number;
    push_chunk(chunk: Uint8Array): Uint8Array;
    stats(): any;
}

export class PairedFilterSession {
    free(): void;
    [Symbol.dispose](): void;
    finish_r1(): any;
    finish_r2(): any;
    constructor(index: WasmIndex, deplete: boolean, abs_threshold: number, rel_threshold: number, decompress_r1: boolean, decompress_r2: boolean, compress_r1: boolean, compress_r2: boolean, rename: boolean, discard_quality: boolean);
    push_r1(chunk: Uint8Array): any;
    push_r2(chunk: Uint8Array): any;
    stats(): any;
}

export class WasmIndex {
    free(): void;
    [Symbol.dispose](): void;
    info(): string;
    constructor(data: Uint8Array, complexity_threshold?: number | null);
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_filtersession_free: (a: number, b: number) => void;
    readonly __wbg_pairedfiltersession_free: (a: number, b: number) => void;
    readonly __wbg_wasmindex_free: (a: number, b: number) => void;
    readonly filtersession_finish: (a: number) => [number, number, number, number];
    readonly filtersession_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly filtersession_output_compressed: (a: number) => number;
    readonly filtersession_pending_bytes: (a: number) => number;
    readonly filtersession_push_chunk: (a: number, b: number, c: number) => [number, number, number, number];
    readonly filtersession_stats: (a: number) => [number, number, number];
    readonly pairedfiltersession_finish_r1: (a: number) => [number, number, number];
    readonly pairedfiltersession_finish_r2: (a: number) => [number, number, number];
    readonly pairedfiltersession_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number];
    readonly pairedfiltersession_push_r1: (a: number, b: number, c: number) => [number, number, number];
    readonly pairedfiltersession_push_r2: (a: number, b: number, c: number) => [number, number, number];
    readonly pairedfiltersession_stats: (a: number) => [number, number, number];
    readonly wasmindex_info: (a: number) => [number, number];
    readonly wasmindex_new: (a: number, b: number, c: number) => [number, number, number];
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
