let active = 0;
const waiting: Array<() => void> = [];
const aborted = () => new DOMException('Thumbnail cancelled', 'AbortError');

export function runThumbnail<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let started = false;
    const cancel = () => {
      if (started) return;
      const index = waiting.indexOf(start);
      if (index >= 0) waiting.splice(index, 1);
      signal.removeEventListener('abort', cancel);
      reject(aborted());
    };
    const start = () => {
      if (signal.aborted) { cancel(); return; }
      started = true;
      signal.removeEventListener('abort', cancel);
      active++;
      Promise.resolve().then(work).then(resolve, reject).finally(() => {
        active--;
        while (active < 3 && waiting.length) waiting.shift()!();
      });
    };
    if (signal.aborted) { reject(aborted()); return; }
    signal.addEventListener('abort', cancel, { once: true });
    if (active < 3) start();
    else waiting.push(start);
  });
}
