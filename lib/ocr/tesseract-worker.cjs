'use strict';

// tesseract.js worker-thread entry, passed as `workerPath` by ./tesseract.ts.
//
// Plain CommonJS on purpose: this runs in a bare worker_thread that Node
// starts from the file path, outside tsx, so neither TypeScript nor the `@/`
// alias is available here. It lives under lib/ because the runtime image
// copies lib/ (not app/ or components/).
//
// Why it exists: an exception inside tesseract's thread (a wasm abort, the
// unguarded `Core(...).then` in its `load` handler) makes Node emit 'error' on
// the parent's Worker object. tesseract.js 7 only sets the browser-style
// `onerror` property, which Node never calls, and ./tesseract.ts can only add
// a real listener once createWorker resolves. A crash during init therefore
// hit an EventEmitter with no 'error' listener, which Node rethrows in the
// PARENT -- taking down the whole worker process.
//
// So the thread never lets an exception escape. On one, it answers every job
// it still owes a reply with tesseract's own 'reject' message (which fails
// createWorker during init, and the job's promise after it), then exits. The
// parent sees a rejection and an 'exit', never an 'error'.

const { parentPort } = require('node:worker_threads');

// Jobs the parent is waiting on, keyed the way tesseract's parent keys its
// promise map (`${action}-${jobId}`). Rejecting a job the parent has already
// settled would throw a TypeError in the parent's message listener -- the very
// crash this file prevents -- so only replies still owed are sent. Messages on
// one port are ordered, so "received minus answered" here is exactly the
// parent's pending set when it reads our reply.
const inFlight = new Map();

parentPort.on('message', (packet) => {
  if (packet && packet.action !== undefined) {
    inFlight.set(`${packet.action}-${packet.jobId}`, packet);
  }
});

const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = (msg, ...rest) => {
  if (msg && (msg.status === 'resolve' || msg.status === 'reject')) {
    inFlight.delete(`${msg.action}-${msg.jobId}`);
  }
  return post(msg, ...rest);
};

let dying = false;
function die(err) {
  if (dying) return;
  dying = true;
  const message = `tesseract thread crashed: ${err instanceof Error ? err.message : String(err)}`;
  for (const packet of inFlight.values()) {
    try {
      post({
        workerId: packet.workerId,
        jobId: packet.jobId,
        action: packet.action,
        status: 'reject',
        data: message,
      });
    } catch {
      // A port that cannot post is a parent that will see 'exit' anyway.
    }
  }
  inFlight.clear();
  process.exit(1);
}

// uncaughtException also receives unhandled rejections under Node's default
// `--unhandled-rejections=throw`, which is how the `load` handler's
// unguarded promise surfaces.
process.on('uncaughtException', die);

require('tesseract.js/src/worker-script/node/index.js');
