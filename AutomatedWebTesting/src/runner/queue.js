'use strict';

/**
 * Simple in-memory job queue with concurrency control and per-job timeout.
 */
class JobQueue {
  constructor(concurrency = 2, jobTimeoutMs = 30 * 60 * 1000) {
    this.concurrency = concurrency;
    this.jobTimeoutMs = jobTimeoutMs;
    this.running = 0;
    this.queue = [];
    this.results = [];
  }

  add(job) {
    this.queue.push(job);
  }

  _wrapWithTimeout(job) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Job timed out after ${this.jobTimeoutMs / 1000}s`));
      }, this.jobTimeoutMs);

      job()
        .then(result => { clearTimeout(timer); resolve(result); })
        .catch(error => { clearTimeout(timer); reject(error); });
    });
  }

  async run() {
    return new Promise((resolve) => {
      const tryNext = () => {
        while (this.running < this.concurrency && this.queue.length > 0) {
          const job = this.queue.shift();
          this.running++;

          this._wrapWithTimeout(job)
            .then(result => {
              this.results.push({ status: 'fulfilled', value: result });
            })
            .catch(error => {
              this.results.push({ status: 'rejected', reason: error });
            })
            .finally(() => {
              this.running--;
              if (this.queue.length === 0 && this.running === 0) {
                resolve(this.results);
              } else {
                tryNext();
              }
            });
        }

        if (this.queue.length === 0 && this.running === 0) {
          resolve(this.results);
        }
      };

      tryNext();
    });
  }
}

module.exports = { JobQueue };
