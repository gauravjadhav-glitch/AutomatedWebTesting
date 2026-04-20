'use strict';

/**
 * Simple in-memory job queue with concurrency control.
 */
class JobQueue {
  constructor(concurrency = 2) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
    this.results = [];
  }

  add(job) {
    this.queue.push(job);
  }

  async run() {
    return new Promise((resolve) => {
      const tryNext = () => {
        while (this.running < this.concurrency && this.queue.length > 0) {
          const job = this.queue.shift();
          this.running++;

          job()
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
