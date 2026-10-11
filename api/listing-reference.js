'use strict';
const { listingURL, readPublicPage, parseListing } = require('../listing-reference-server');
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  try {
    const url = listingURL(req.query?.url);
    const vehicle = parseListing(await readPublicPage(url.href));
    if (!vehicle) return res.status(422).json({ error: 'VEHICLE_NOT_IDENTIFIED' });
    return res.status(200).json({ vehicle });
  } catch (error) {
    if (error.message !== 'INVALID_URL') console.warn('listing-reference read failed:', error.code || error.message); // No visitor URL or listing data in logs.
    return res.status(error.message === 'INVALID_URL' ? 400 : 503).json({ error: error.message === 'INVALID_URL' ? 'INVALID_URL' : 'LISTING_UNAVAILABLE' });
  }
};
