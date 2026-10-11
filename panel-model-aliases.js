'use strict';
const catalog = require('./vehicle-catalog');
// Read the small database dictionary once per request; a new alias is effective without deploy.
async function load(ctx, services = {}) {
  if (ctx.modelAliasesLoaded) return;
  if (!ctx.modelAliasesLoading) {
    const { rpc, memoRead } = require('./panel-server');
    const call = services.rpc || rpc;
    // Boot handlers have separate contexts but share this request's readCache.
    ctx.modelAliasesLoading = Promise.resolve().then(() => memoRead(ctx, 'rpc:panel_model_dictionary:{}', async () => {
      const result = await call(ctx, 'panel_model_dictionary', {});
      const data = Array.isArray(result) ? result[0] : result;
      if (!data || !Array.isArray(data.aliases)) throw new Error('MODEL_DICTIONARY_UNAVAILABLE');
      return result;
    })).then(result => {
      const data = Array.isArray(result) ? result[0] : result;
      catalog.configureAliases(data.aliases, data.known || [], data.revision);
      ctx.modelAliasesLoaded = true;
      ctx.modelDictionary = data;
    }).finally(() => { delete ctx.modelAliasesLoading; });
  }
  await ctx.modelAliasesLoading;
}
module.exports = { load };
