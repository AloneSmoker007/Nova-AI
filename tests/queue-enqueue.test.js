import assert from "node:assert/strict";
import test from "node:test";

import * as queueService from "../src/services/queue.service.js";

// P0-WS-A finding 8: `jobId = inboxId` combined with BullMQ retention
// (removeOnComplete / removeOnFail) means a RETAINED terminal job silently
// suppresses re-enqueue of the same job id.
//
// This behaviour is proven from the installed BullMQ 6.3.6 source:
// node_modules/bullmq/dist/cjs/commands/addStandardJob-9.lua
//   `if rcall("EXISTS", jobIdKey) == 1 then return handleDuplicatedJob(...)`
// i.e. Queue.add() with an existing jobId creates NO new job, without error.
//
// No Redis server exists in this environment (verified: no redis/valkey
// binaries, nothing listening on 6379), so a live BullMQ+Redis integration run
// is not possible here. The queue double below reproduces exactly the two BullMQ
// surfaces involved: the jobId dedupe of addStandardJob-9.lua and the public
// Queue.getJob()/Job.getState()/Job.remove() API. The logic under test is ours
// (enqueueWhatsAppMessage), not BullMQ's.

function makeQueueDouble(initialJobs = []) {
  const jobs = new Map(initialJobs.map((job) => [job.id, { ...job }]));
  const added = [];

  return {
    jobs,
    added,
    async getJob(id) {
      if (!jobs.has(id)) return undefined;
      return {
        id,
        async getState() {
          return jobs.get(id)?.state ?? "unknown";
        },
        async remove() {
          if (!jobs.has(id)) {
            throw new Error(`Job ${id} does not exist`);
          }
          jobs.delete(id);
        },
      };
    },
    async add(name, data, opts) {
      // addStandardJob-9.lua: an existing jobId is returned as a duplicate and
      // NO new job is created.
      const id = opts?.jobId ?? `generated-${added.length + 1}`;
      if (jobs.has(id)) {
        return { id, deduplicated: true };
      }
      jobs.set(id, { state: "waiting", name, data, opts });
      added.push(id);
      return { id };
    },
  };
}

test("a retained failed job must not suppress re-enqueue of the same inbox id", async () => {
  const queue = makeQueueDouble([{ id: "inbox-1", state: "failed" }]);

  await queueService.enqueueWhatsAppMessage({ inboxId: "inbox-1", queue });

  assert.deepEqual(queue.added, ["inbox-1"], "the job must actually be re-enqueued");
  assert.equal(queue.jobs.size, 1, "the retained failed job must be replaced, not duplicated");
  assert.equal(queue.jobs.get("inbox-1").state, "waiting");
  assert.equal(queue.jobs.get("inbox-1").opts.jobId, "inbox-1");
});

test("a retained completed job must not suppress re-enqueue of the same inbox id", async () => {
  const queue = makeQueueDouble([{ id: "inbox-2", state: "completed" }]);

  await queueService.enqueueWhatsAppMessage({ inboxId: "inbox-2", queue });

  assert.deepEqual(queue.added, ["inbox-2"]);
  assert.equal(queue.jobs.get("inbox-2").state, "waiting");
});

test("an active or waiting job keeps its dedupe — no duplicate enqueue", async () => {
  for (const state of ["waiting", "active"]) {
    const queue = makeQueueDouble([{ id: "inbox-3", state }]);

    await queueService.enqueueWhatsAppMessage({ inboxId: "inbox-3", queue });

    assert.deepEqual(queue.added, [], `a ${state} job must not be re-enqueued`);
    assert.equal(queue.jobs.size, 1);
    assert.equal(queue.jobs.get("inbox-3").state, state, "the live job must be left untouched");
  }
});

test("a clean queue enqueues exactly one job per inbox id", async () => {
  const queue = makeQueueDouble();

  await queueService.enqueueWhatsAppMessage({ inboxId: "inbox-4", queue });
  await queueService.enqueueWhatsAppMessage({ inboxId: "inbox-4", queue });

  assert.equal(queue.added.length, 1, "the second enqueue must hit the jobId dedupe");
  assert.equal(queue.jobs.size, 1);
});
