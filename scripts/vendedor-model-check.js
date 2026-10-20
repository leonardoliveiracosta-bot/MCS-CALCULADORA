'use strict';
// Deployment check only: lists accessible model IDs, never prompts or credentials
const {sonnetModel}=require('../panel-vendedor');
sonnetModel().then(model=>console.log('MCS_VENDEDOR_SONNET='+model)).catch(()=>{console.error('MCS_VENDEDOR_MODEL_LIST_UNAVAILABLE');process.exitCode=1;});
