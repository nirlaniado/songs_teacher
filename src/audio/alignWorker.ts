import { alignWorkerHandler } from "./alignModel.js";

const handle = alignWorkerHandler((reply, transfer) => self.postMessage(reply, { transfer }));
self.onmessage = (event: MessageEvent) => void handle(event.data);
