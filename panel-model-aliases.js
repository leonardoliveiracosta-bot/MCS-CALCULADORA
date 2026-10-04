'use strict';
const catalog = require('./vehicle-catalog');
// Read the small database dictionary once per request; a new alias is effective without deploy.
async function load(ctx, services = {}) {
  if (ctx.modelAliasesLoaded) return;
  const call = services.rpc || require('./panel-server').rpc;
  const result = await call(ctx, 'panel_model_dictionary', {});
  const data = Array.isArray(result) ? result[0] : result;
  if (!data || !Array.isArray(data.aliases)) throw new Error('MODEL_DICTIONARY_UNAVAILABLE');
  catalog.configureAliases(data.aliases, data.known || [], data.revision);
  ctx.modelAliasesLoaded = true;
  ctx.modelDictionary = data;
}
module.exports = { load };
