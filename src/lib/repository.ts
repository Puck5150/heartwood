// Runtime dispatcher: picks the real Tauri/SQLite-backed repository when
// running inside Tauri, or a browser-safe in-memory fallback when running
// the plain Vite dev server (`npm run dev`) outside of Tauri — without this,
// @tauri-apps/plugin-sql throws ("Cannot read properties of undefined
// (reading 'invoke')") because there's no Tauri IPC bridge to talk to.
// See memoryRepository.ts for what the fallback does and doesn't do.

import { isTauri } from '@tauri-apps/api/core';
import * as memoryRepository from './memoryRepository';
import * as tauriRepository from './tauriRepository';

const backend = isTauri() ? tauriRepository : memoryRepository;

export const saveSession = backend.saveSession;
export const loadLatestSessionRow = backend.loadLatestSessionRow;
export const insertParkedThought = backend.insertParkedThought;
export const deleteParkedThoughtRow = backend.deleteParkedThoughtRow;
export const loadAllParkedThoughts = backend.loadAllParkedThoughts;
