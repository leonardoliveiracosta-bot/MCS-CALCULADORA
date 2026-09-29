'use strict';
// Unit tests never reach the network: any real fetch answers 403, as an egress proxy would.
globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => '', json: async () => ({}) });
