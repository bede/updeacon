/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const __wbg_filtersession_free: (a: number, b: number) => void;
export const __wbg_pairedfiltersession_free: (a: number, b: number) => void;
export const __wbg_wasmindex_free: (a: number, b: number) => void;
export const filtersession_finish: (a: number) => [number, number, number, number];
export const filtersession_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
export const filtersession_output_compressed: (a: number) => number;
export const filtersession_pending_bytes: (a: number) => number;
export const filtersession_push_chunk: (a: number, b: number, c: number) => [number, number, number, number];
export const filtersession_stats: (a: number) => [number, number, number];
export const pairedfiltersession_finish_r1: (a: number) => [number, number, number];
export const pairedfiltersession_finish_r2: (a: number) => [number, number, number];
export const pairedfiltersession_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => number;
export const pairedfiltersession_push_r1: (a: number, b: number, c: number) => [number, number, number];
export const pairedfiltersession_push_r2: (a: number, b: number, c: number) => [number, number, number];
export const pairedfiltersession_stats: (a: number) => [number, number, number];
export const wasmindex_info: (a: number) => [number, number];
export const wasmindex_new: (a: number, b: number, c: number) => [number, number, number];
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_start: () => void;
