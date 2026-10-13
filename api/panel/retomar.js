'use strict';

// RETOMAR (/retomar): GET lists the clients waiting more than 15 days with their progress; POST {action:'prepare'}
// builds and saves the 3 texts of a ficha; POST {action:'step', parts} saves the part reached (the 3rd records
// "Opções enviadas"). Nothing is sent from here: every message goes out by the operator, from WhatsApp or the phone.
const { jsonBody, requirePanel, send } = require('../../panel-server');
const retomar = require('../../panel-retomar');

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    if (req.method === 'GET') return send(res, 200, await retomar.list(ctx));
    const body = await jsonBody(req, 8192);
    const out = body.action === 'prepare' ? await retomar.prepare(ctx, body)
      : body.action === 'step' ? await retomar.step(ctx, body)
        : { status: 400, error: 'ACTION_INVALID' };
    const { status, ...rest } = out;
    return send(res, status || 200, rest);
  } catch (error) {
    console.error('[retomar]', { message: String(error && error.message || 'UNKNOWN').slice(0, 200) });
    return send(res, 503, { error: 'RETOMAR_UNAVAILABLE' });
  }
};
