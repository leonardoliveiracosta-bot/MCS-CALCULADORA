'use strict';

const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const localVisual = process.env.PANEL_VISUAL_LOCAL === '1';

module.exports = {
  use: localVisual ? { ignoreHTTPSErrors:true } : proxy ? { proxy: { server: proxy }, ignoreHTTPSErrors: true } : {},
  webServer: localVisual ? { command:'python3 -m http.server 4173',url:'http://127.0.0.1:4173/painel/',reuseExistingServer:false,timeout:30000 } : undefined
};
