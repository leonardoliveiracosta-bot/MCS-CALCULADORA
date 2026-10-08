'use strict';

// Coalesce only the four already validated boot history transports. Each caller
// keeps its own promise/result; a bad projection does not fail unrelated sources.
module.exports = function createHistoryBatch(call, fallback) {
  let pending = [], scheduled = false;
  const flush = async () => {
    scheduled = false;
    const entries = pending; pending = [];
    for (let offset = 0; offset < entries.length; offset += 16) {
      const batch = entries.slice(offset, offset + 16);
      try {
        let result;
        try { result = await call(batch.map(({table,columns}) => ({table,columns}))); }
        catch (error) {
          if (error.status !== 404) throw error;
          // Compatible additive rollout: old single-source RPCs remain available.
          result = await Promise.all(batch.map(async ({table,columns}) => {
            try { return { data: await fallback(table,columns) }; }
            catch (error) { return { failure: error }; }
          }));
        }
        if (!Array.isArray(result) || result.length !== batch.length) throw new Error('INVALID_HISTORY_BATCH');
        batch.forEach((entry,index) => {
          const item = result[index];
          if (item?.failure) return entry.reject(item.failure);
          if (item?.error) {
            const failure = new Error('SUPABASE_REQUEST_FAILED');
            failure.status = item.status || 500; failure.code = item.error;
            return entry.reject(failure);
          }
          if (!Array.isArray(item?.data)) return entry.reject(new Error('INVALID_HISTORY_BATCH'));
          entry.resolve(item.data);
        });
      } catch (error) { batch.forEach(entry => entry.reject(error)); }
    }
  };
  return { load(table, columns) { return new Promise((resolve,reject) => {
    pending.push({table,columns,resolve,reject});
    if (!scheduled) { scheduled = true; setImmediate(flush); }
  }); } };
};
