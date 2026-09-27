'use strict';

const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

module.exports = {
  use: proxy ? { proxy: { server: proxy }, ignoreHTTPSErrors: true } : {}
};
