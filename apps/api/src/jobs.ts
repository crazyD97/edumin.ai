/**
 * In-process scheduled jobs. Fine for a single API node; move to a queue
 * (e.g. pg-boss/BullMQ) when running several instances.
 */
import type { FastifyBaseLogger } from 'fastify';
import { drainEmailOutbox } from './core/notify';

type Job = { name: string; everyMs: number; run: () => Promise<unknown> };

const jobs: Job[] = [{ name: 'email-outbox', everyMs: 30_000, run: () => drainEmailOutbox() }];

export function registerJob(job: Job) {
  jobs.push(job);
}

export function startJobs(log: FastifyBaseLogger) {
  for (const job of jobs) {
    let running = false;
    setInterval(async () => {
      if (running) return;
      running = true;
      try {
        await job.run();
      } catch (err) {
        log.error({ err, job: job.name }, 'job failed');
      } finally {
        running = false;
      }
    }, job.everyMs).unref();
  }
}
