/**
 * solveAsync(items, menu, config) -> Promise of a solveMenu() result.
 * Uses a background Web Worker when the browser supports module workers,
 * and falls back to solving on the page itself if it doesn't.
 */
import { solveMenu } from "./optimizer.js";

const pending = new Map();      // request id -> { args, resolve, reject }
let nextId = 1;
let worker = null;

function solveHere({ args, resolve, reject }) {
  try { resolve(solveMenu(...args)); } catch (error) { reject(error); }
}

try {
  worker = new Worker(new URL("./solver-worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    const job = pending.get(data.id);
    if (!job) return;
    pending.delete(data.id);
    if (data.error) job.reject(new Error(data.error));
    else job.resolve(data.result);
  };
  worker.onerror = () => {      // worker failed to start: finish everything on the page instead
    worker = null;
    for (const job of pending.values()) solveHere(job);
    pending.clear();
  };
} catch {
  worker = null;
}

export function solveAsync(items, menu, config) {
  return new Promise((resolve, reject) => {
    const job = { args: [items, menu, config], resolve, reject };
    if (!worker) {
      setTimeout(() => solveHere(job), 0);   // still async, so the page can paint first
      return;
    }
    const id = nextId++;
    pending.set(id, job);
    worker.postMessage({ id, items, menu, config });
  });
}
