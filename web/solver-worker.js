// Runs the optimizer on a background thread so the page never freezes while solving.
import { solveMenu } from "./optimizer.js";

self.onmessage = (event) => {
  const { id, items, menu, config } = event.data;
  try {
    self.postMessage({ id, result: solveMenu(items, menu, config) });
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
