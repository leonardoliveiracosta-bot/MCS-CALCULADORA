'use strict';

// One boot request shares this budget across its list handlers. Only network table reads
// occupy slots; cache hits, application work and mutations never wait in this queue.
module.exports = function createReadBudget(limit = 8) {
  let active = 0;
  const pending = [];
  function drain() {
    while (active < limit && pending.length) {
      const next = pending.shift();
      active += 1;
      Promise.resolve().then(next.load).then(next.resolve, next.reject).finally(() => {
        active -= 1;
        drain();
      });
    }
  }
  return {
    run(load) {
      return new Promise((resolve, reject) => {
        pending.push({load, resolve, reject});
        drain();
      });
    }
  };
};
